"""Elevation sources: PDS3 raw IMG rasters (equirectangular or polar stereographic),
read through numpy memmaps, with a cached 2x2-mean overview pyramid for alias-free
sampling at every quadtree level.

All heights are returned in metres relative to the 1737.4 km reference sphere.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .geom import R_MOON

NODATA_INT16 = -32768


def parse_pds3_label(path: Path) -> dict:
    """Very small PDS3 ODL parser: returns flat dict of KEY -> raw string value
    (last occurrence wins; units in <...> stripped)."""
    txt = path.read_text(errors="replace")
    txt = re.sub(r"/\*.*?\*/", "", txt, flags=re.S)
    out: dict[str, str] = {}
    for m in re.finditer(r"^\s*([A-Z0-9_^:]+)\s*=\s*(.+?)\s*$", txt, flags=re.M):
        key, val = m.group(1), m.group(2)
        val = re.sub(r"<[^>]*>", "", val).strip().strip('"').strip("'").strip()
        out[key] = val
    return out


@dataclass
class Source:
    name: str
    path: Path               # .IMG
    proj: str                # "eqc" | "polar"
    width: int
    height: int
    dtype: str               # numpy dtype string of raw samples
    scale: float             # raw * scale -> metres (after offset removal)
    res_m: float             # nominal ground resolution of level 0 (m / px)
    # projection params
    ppd: float = 0.0                  # eqc
    center_lon: float = 0.0           # eqc
    line_off: float = 0.0             # pixel-centre convention (0-based)
    sample_off: float = 0.0
    lat_min: float = -90.0            # coverage (eqc) or cap edge (polar)
    lat_max: float = 90.0
    pole: int = 0                     # polar: -1 south, +1 north
    map_scale: float = 0.0            # polar m/px
    blend_deg: float = 1.0            # width of the blend-in ramp at the coverage edge
    polar_flip: tuple = (1, 1)        # empirically verified orientation (sx, sy)
    despike_m: float = 0.0            # >0: replace isolated outliers (> this many m from the 3x3 median)
    _levels: list = field(default_factory=list, repr=False)

    # ---------------------------------------------------------------- loading
    @staticmethod
    def from_label(name: str, lbl: Path, img: Path, blend_deg: float = 1.0) -> "Source":
        L = parse_pds3_label(lbl)
        st = L["SAMPLE_TYPE"].upper()
        bits = int(L["SAMPLE_BITS"])
        if st in ("PC_REAL",) and bits == 32:
            dtype = "<f4"
        elif st in ("LSB_INTEGER", "PC_INTEGER") and bits == 16:
            dtype = "<i2"
        else:
            raise ValueError(f"unsupported sample type {st}/{bits}")
        unit = L.get("UNIT", "METER").upper()
        scale = float(L.get("SCALING_FACTOR", "1"))
        if unit.startswith("KILOMETER"):
            scale *= 1000.0
        w, h = int(L["LINE_SAMPLES"]), int(L["LINES"])
        ptype = L["MAP_PROJECTION_TYPE"].upper()
        lo, so = float(L["LINE_PROJECTION_OFFSET"]), float(L["SAMPLE_PROJECTION_OFFSET"])
        if "CYLINDRICAL" in ptype:
            ppd = float(L["MAP_RESOLUTION"])
            return Source(name, img, "eqc", w, h, dtype, scale,
                          res_m=np.pi * R_MOON / 180 / ppd, ppd=ppd,
                          center_lon=float(L["CENTER_LONGITUDE"]), line_off=lo, sample_off=so,
                          lat_min=float(L["MINIMUM_LATITUDE"]), lat_max=float(L["MAXIMUM_LATITUDE"]),
                          blend_deg=blend_deg)
        if "POLAR" in ptype:
            ms = float(L["MAP_SCALE"])
            if ms < 1.0:  # given in km
                ms *= 1000.0
            clat = float(L["CENTER_LATITUDE"])
            pole = -1 if clat < 0 else 1
            lat_edge = float(L["MAXIMUM_LATITUDE"]) if pole < 0 else float(L["MINIMUM_LATITUDE"])
            return Source(name, img, "polar", w, h, dtype, scale, res_m=ms,
                          line_off=lo, sample_off=so, pole=pole, map_scale=ms,
                          lat_min=min(lat_edge, clat), lat_max=max(lat_edge, clat),
                          blend_deg=blend_deg)
        raise ValueError(f"unsupported projection {ptype}")

    # ------------------------------------------------------------- overviews
    def level0(self) -> np.ndarray:
        return np.memmap(self.path, dtype=self.dtype, mode="r", shape=(self.height, self.width))

    def read_metres(self, r0: int, r1: int, c0: int, c1: int) -> np.ndarray:
        """Level-0 window [r0:r1, c0:c1] in metres, despiked if configured. The despike
        filter sees a 1-pixel margin, so results do not depend on the window origin
        (adjacent tiles get identical values on shared samples)."""
        a = self.level0()
        if self.despike_m <= 0:
            return self._to_metres(np.asarray(a[r0:r1, c0:c1]))
        R0, R1 = max(0, r0 - 1), min(self.height, r1 + 1)
        C0, C1 = max(0, c0 - 1), min(self.width, c1 + 1)
        v = despike(self._to_metres(np.asarray(a[R0:R1, C0:C1])), self.despike_m)
        return v[r0 - R0: r0 - R0 + (r1 - r0), c0 - C0: c0 - C0 + (c1 - c0)]

    def build_overviews(self, cache: Path, min_size: int = 64) -> None:
        """Write float32 overview k (k >= 1) = 2x2 mean of k-1 (NaN aware) to cache."""
        cache.mkdir(parents=True, exist_ok=True)
        src = self.level0()
        k = 1
        h, w = self.height, self.width
        prev_path = None
        while min(h, w) // 2 >= min_size:
            h2, w2 = h // 2, w // 2
            path = cache / f"{self.name}_ov{k}.f32"
            meta = cache / f"{self.name}_ov{k}.json"
            if not (path.exists() and meta.exists()):
                prev = src if k == 1 else np.memmap(prev_path, dtype="<f4", mode="r", shape=(h, w))
                tmp = path.with_suffix(".tmp")
                out = np.memmap(tmp, dtype="<f4", mode="w+", shape=(h2, w2))
                rows = max(2, (64 << 20) // max(1, w * 4) // 2 * 2)
                for r in range(0, h2 * 2, rows):
                    if k == 1:
                        blk = self.read_metres(r, min(r + rows, h2 * 2), 0, w2 * 2)
                    else:
                        blk = np.asarray(prev[r:min(r + rows, h2 * 2), : w2 * 2])
                    blk = blk.reshape(blk.shape[0] // 2, 2, w2, 2)
                    with np.errstate(invalid="ignore"):
                        out[r // 2: r // 2 + blk.shape[0]] = np.nanmean(blk, axis=(1, 3))
                out.flush()
                del out
                tmp.replace(path)
                meta.write_text(json.dumps({"h": h2, "w": w2}))
            prev_path = path
            h, w, k = h2, w2, k + 1

    def open_levels(self, cache: Path) -> None:
        self._levels = [(self.level0(), True)]
        k = 1
        while True:
            meta = cache / f"{self.name}_ov{k}.json"
            if not meta.exists():
                break
            m = json.loads(meta.read_text())
            arr = np.memmap(cache / f"{self.name}_ov{k}.f32", dtype="<f4", mode="r", shape=(m["h"], m["w"]))
            self._levels.append((arr, False))
            k += 1

    def _to_metres(self, raw: np.ndarray) -> np.ndarray:
        v = raw.astype(np.float32)
        if self.dtype == "<i2":
            v[raw == NODATA_INT16] = np.nan
            v *= self.scale
        else:
            v *= self.scale
            v[~np.isfinite(v) | (np.abs(v) > 25000)] = np.nan
        return v

    # ------------------------------------------------------------ projection
    def pixel_coords(self, lat: np.ndarray, lon: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Level-0 fractional pixel coords (col, row), pixel centres at integers."""
        if self.proj == "eqc":
            dl = (lon - self.center_lon + 180.0) % 360.0 - 180.0  # relative to center lon
            col = self.sample_off + dl * self.ppd
            row = self.line_off - lat * self.ppd
            return col, row
        # polar stereographic (spherical), true scale at the pole
        la, lo = np.radians(lat), np.radians(lon)
        if self.pole < 0:
            rho = 2 * R_MOON * np.tan(np.pi / 4 + la / 2)
            x, y = rho * np.sin(lo), rho * np.cos(lo)
        else:
            rho = 2 * R_MOON * np.tan(np.pi / 4 - la / 2)
            x, y = rho * np.sin(lo), -rho * np.cos(lo)
        sx, sy = self.polar_flip
        col = self.sample_off + sx * x / self.map_scale
        row = self.line_off - sy * y / self.map_scale
        return col, row

    def weight(self, lat: np.ndarray) -> np.ndarray:
        """Blend weight from coverage: ramps 0 -> 1 over blend_deg inside the edge."""
        if self.proj == "eqc":
            if self.lat_min <= -89.9 and self.lat_max >= 89.9:
                return np.ones_like(lat)
            d = np.minimum(lat - self.lat_min, self.lat_max - lat)
        elif self.pole < 0:  # covers lat <= lat_max (e.g. -87.5)
            d = self.lat_max - lat
        else:                # covers lat >= lat_min (e.g. 75)
            d = lat - self.lat_min
        return np.clip(d / self.blend_deg, 0.0, 1.0)

    def sample(self, lat: np.ndarray, lon: np.ndarray, cell_m) -> np.ndarray:
        """Trilinear sample: bilinear within the two overview levels bracketing the
        per-sample footprint `cell_m` (scalar or array), blended by the fractional level.
        NaN where unavailable."""
        nlev = len(self._levels)
        kf = np.log2(np.maximum(np.asarray(cell_m, dtype=np.float64), 1e-9) / self.res_m)
        kf = np.clip(np.broadcast_to(kf, lat.shape), 0.0, nlev - 1)
        k0 = np.floor(kf).astype(np.int64)
        t = (kf - k0).astype(np.float32)
        out = np.full(lat.shape, np.nan, np.float32)
        lo_all = {}
        for k in range(int(k0.min()), min(nlev - 1, int(k0.max()) + 1) + 1):
            lo_all[k] = self._sample_level(k, lat, lon)
        for k in np.unique(k0):
            m = k0 == k
            a = lo_all[int(k)][m]
            if k + 1 < nlev:
                b = lo_all[int(k) + 1][m]
                tt = t[m]
                out[m] = a * (1 - tt) + b * tt
            else:
                out[m] = a
        return out

    def _sample_level(self, k: int, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
        """Bilinear sample of overview level k. NaN where unavailable."""
        arr, raw = self._levels[k]
        col, row = self.pixel_coords(lat, lon)
        f = 2.0 ** k
        # level-k pixel centre i covers level-0 pixels [i*f, i*f+f) -> centre at i*f + (f-1)/2
        col = (col - (f - 1) / 2) / f
        row = (row - (f - 1) / 2) / f
        H, W = arr.shape
        c0 = np.floor(col).astype(np.int64)
        r0 = np.floor(row).astype(np.int64)
        fc = (col - c0).astype(np.float32)
        fr = (row - r0).astype(np.float32)
        wrap = self.proj == "eqc"  # all cylindrical sources used here span 360 deg

        valid = (r0 >= 0) & (r0 + 1 < H)
        if not wrap:
            valid &= (c0 >= 0) & (c0 + 1 < W)
        if not valid.any():
            return np.full(lat.shape, np.nan, np.float32)
        rmin, rmax = int(r0[valid].min()), int(r0[valid].max()) + 1
        r0c = np.clip(r0, rmin, rmax - 1)
        if wrap:
            cols = np.unique(np.concatenate([c0[valid] % W, (c0[valid] + 1) % W]))
            # read the needed column span; handle wrap by reading full rows when spanning seam
            if cols[-1] - cols[0] + 1 > W // 2:
                block = np.asarray(arr[rmin:rmax + 1, :])
                cbase = 0
            else:
                block = np.asarray(arr[rmin:rmax + 1, cols[0]:cols[-1] + 1])
                cbase = int(cols[0])
            ci0 = (c0 % W) - cbase
            ci1 = ((c0 + 1) % W) - cbase
            if cbase:
                ci0 = np.clip(ci0, 0, block.shape[1] - 1)
                ci1 = np.clip(ci1, 0, block.shape[1] - 1)
        else:
            cmin, cmax = int(c0[valid].min()), int(c0[valid].max()) + 1
            if raw:
                block = self.read_metres(rmin, rmax + 1, cmin, cmax + 1)
                raw = False
            else:
                block = np.asarray(arr[rmin:rmax + 1, cmin:cmax + 1])
            ci0 = np.clip(c0, cmin, cmax - 1) - cmin
            ci1 = ci0 + 1
        if raw:
            block = self._to_metres(block)
        ri0 = r0c - rmin
        v00 = block[ri0, ci0]
        v01 = block[ri0, ci1]
        v10 = block[ri0 + 1, ci0]
        v11 = block[ri0 + 1, ci1]
        out = (v00 * (1 - fc) + v01 * fc) * (1 - fr) + (v10 * (1 - fc) + v11 * fc) * fr
        out[~valid] = np.nan
        return out.astype(np.float32)


def despike(v: np.ndarray, thr: float) -> np.ndarray:
    """Replace isolated samples deviating > thr metres from their 3x3 median (LOLA
    gridding outliers) by that median. Edges use the available neighbours only."""
    from scipy.ndimage import median_filter
    med = median_filter(v, size=3, mode="nearest")
    bad = np.abs(v - med) > thr
    if bad.any():
        v = v.copy()
        v[bad] = med[bad]
    return v


def load_sources(cfg: dict, raw: Path) -> list[Source]:
    """Instantiate sources (coarse -> fine order = compositing order)."""
    out = []
    for s in cfg["elevation_sources"]:
        img = raw / s["img"]
        lbl = raw / s["lbl"]
        if not img.exists() or not lbl.exists():
            if s.get("optional"):
                print(f"  (skipping optional source {s['name']}: not downloaded)")
                continue
            raise FileNotFoundError(img)
        src = Source.from_label(s["name"], lbl, img, blend_deg=s.get("blend_deg", 1.0))
        if "polar_flip" in s:
            src.polar_flip = tuple(s["polar_flip"])
        src.despike_m = float(s.get("despike_m", 0.0))
        if "max_level" in s:
            src.max_level = s["max_level"]  # type: ignore[attr-defined]
        out.append(src)
    return out
