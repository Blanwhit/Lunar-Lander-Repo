"""Precompute the static inputs of the feasibility overlay on a cube-sphere grid.

    python -I pipeline/feasibility_grid.py [--workers 24] [--polar-lat 84] [--polar-level 6]

Score tiles form their own quadtree (same faces / EAC mapping as the terrain):
  * levels 0..3 everywhere (64 x 64 samples per tile; ~5.3 km spacing at level 3)
  * levels 4..polar-level wherever |lat| >= polar-lat (~670 m spacing at level 6)
Samples are corner-aligned (edge samples shared with the neighbour tile).

For every sample, from the same height tiles the viewer and the site API use:
  height, slope + aspect (central differences over 2 grid cells), prominence (height
  minus the mean of 8 points on a 3 km ring), a 64-azimuth terrain horizon (ray march with
  the site API's rules: ~0.15 deg angular resolution, stop when even +10.8 km terrain could
  no longer rise above the horizon), and statistics over the reference year 2026 (6 h
  steps, JPL Horizons ephemeris + IAU 2015 rotation): mean visible solar-disc fraction,
  fraction of time the Earth's centre is above the terrain horizon, mean absorbed solar
  flux on the local slope (drives the viewer's temperature proxy).

The viewer evaluates the time-dependent part (Sun/Earth now, hours remaining, temperature)
in a Web Worker and combines everything with web/src/api/feasibility.ts.

Output: web/public/tiles/f/{L}/{face}/{y}/{x}.bin (zlib), format "MLF1":
    0  char[4] magic | 4 u8 level | 5 u8 face | 6 u8 child mask | 7 u8 S
    8  u32 x | 12 u32 y | 16 u16 NAZ | 18 u16 reserved
    then arrays (row = b index, col = a index), little-endian:
      int8   horizon[S*S*NAZ]   elevation in 0.25 deg units (sample-major, azimuth i*360/NAZ
                                clockwise from north)
      int16  height[S*S]        m vs 1737.4 km
      uint16 slope[S*S]         0.01 deg
      uint16 aspect[S*S]        0.01 deg downslope azimuth (65535 = flat)
      int16  prominence[S*S]    m
      uint16 annualSun[S*S]     mean visible solar-disc fraction * 65535
      uint16 annualEarth[S*S]   fraction of time Earth centre above horizon * 65535
      uint16 meanAbsorbed[S*S]  mean absorbed flux on the slope, 0.01 W/m^2
"""
from __future__ import annotations

import argparse
import json
import os
import struct
import sys
import time
import zlib
from multiprocessing import Pool
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ephemeris import iau_moon, tdb_minus_utc_s  # noqa: E402
from moonlod import geom  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
TILES = ROOT / "web" / "public" / "tiles"
CACHE = ROOT / "data" / "cache"
EPHEM = ROOT / "web" / "public" / "ephem"
R = geom.R_MOON
S = 64
NAZ = 64
ANG = 0.0026  # target angular resolution of the terrain grid along a ray (~0.15 deg)
H_MAX = 10800.0
OBS_H = 2.0
RING_M = 3000.0
REF_YEAR = 2026
R_SUN_KM, R_EARTH_KM, AU_KM = 695700.0, 6371.0, 149597870.7
TEX0 = (np.pi / 2 * R) / 256  # texel size at level 0 (m)
FACES = geom.FACES


def texel(level):
    return TEX0 / (2.0 ** np.asarray(level))


# ------------------------------------------------------------------ tile store
def decode_mlh1(blob: bytes):
    raw = zlib.decompress(blob)
    L, f, cm, _, x, y, hmin, hmax, step, base, G, _ = struct.unpack_from("<4xBBBBIIffffHH", raw, 0)
    n = G * G
    lo = np.frombuffer(raw, np.uint8, n, 36).astype(np.int64)
    hi = np.frombuffer(raw, np.uint8, n, 36 + n).astype(np.int64)
    z = (lo | (hi << 8)).reshape(G, G)
    r = (z >> 1) ^ -(z & 1)
    q = (np.cumsum(np.cumsum(r, axis=0), axis=1) & 0xFFFF).astype(np.uint16)  # planar predictor inverse
    return L, f, cm, x, y, step, base, q


def build_store(max_global: int, polar_lat: float, max_polar: int) -> dict:
    """decode the needed height tiles into one memmapped stack + per-level lookup tables"""
    CACHE.mkdir(parents=True, exist_ok=True)
    meta_p = CACHE / "feas_store.json"
    if meta_p.exists():
        m = json.loads(meta_p.read_text())
        if m.get("key") == [max_global, polar_lat, max_polar]:
            return m
    keys = []
    for p in (TILES / "h").rglob("*.bin"):
        L = int(p.parts[-4])
        if L > max_polar:
            continue
        f, yy, xx = int(p.parts[-3]), int(p.parts[-2]), int(p.stem)
        if L > max_global:
            # only near the poles: tile centre latitude
            span = 2 / (1 << L)
            d = geom.face_dirs(f, np.array(-1 + (xx + 0.5) * span), np.array(-1 + (yy + 0.5) * span))
            if abs(np.degrees(np.arcsin(d[2]))) < polar_lat - 1.5:
                continue
        keys.append((L, f, xx, yy, p))
    keys.sort()
    n = len(keys)
    print(f"height store: {n} tiles ({n * 259 * 259 * 2 / 1e9:.2f} GB)", flush=True)
    stack = np.lib.format.open_memmap(CACHE / "feas_stack.npy", mode="w+", dtype=np.uint16, shape=(n, 259, 259))
    base = np.zeros(n, np.float64)
    step = np.zeros(n, np.float64)
    tables = {}
    for i, (L, f, xx, yy, p) in enumerate(keys):
        _, _, _, _, _, st, bs, q = decode_mlh1(p.read_bytes())
        stack[i] = q
        base[i], step[i] = bs, st
        if L not in tables:
            tables[L] = np.full((6, 1 << L, 1 << L), -1, np.int32)
        tables[L][f, yy, xx] = i
        if (i + 1) % 5000 == 0:
            print(f"  decoded {i + 1}/{n}", flush=True)
    stack.flush()
    del stack
    np.save(CACHE / "feas_base.npy", base)
    np.save(CACHE / "feas_step.npy", step)
    for L, t in tables.items():
        np.save(CACHE / f"feas_table_L{L}.npy", t)
    m = {"key": [max_global, polar_lat, max_polar], "levels": sorted(tables)}
    meta_p.write_text(json.dumps(m))
    return m


class Terrain:
    def __init__(self, levels):
        self.stack = np.load(CACHE / "feas_stack.npy", mmap_mode="r")
        self.base = np.load(CACHE / "feas_base.npy")
        self.step = np.load(CACHE / "feas_step.npy")
        self.tables = {L: np.load(CACHE / f"feas_table_L{L}.npy") for L in levels}
        self.maxL = max(levels)

    def sample(self, d: np.ndarray, level) -> tuple[np.ndarray, np.ndarray]:
        """heights at unit directions d (..,3) from the deepest stored tile <= level"""
        face, a, b = dirs_to_face(d)
        lev = np.minimum(np.broadcast_to(np.asarray(level), face.shape), self.maxL).astype(np.int64)
        idx = np.full(face.shape, -1, np.int64)
        used = np.zeros(face.shape, np.int64)
        todo = np.ones(face.shape, bool)
        for L in range(self.maxL, -1, -1):
            m = todo & (lev >= L)
            if not m.any():
                continue
            if L not in self.tables:
                continue
            n = 1 << L
            tx = np.clip(((a[m] + 1) / 2 * n).astype(np.int64), 0, n - 1)
            ty = np.clip(((b[m] + 1) / 2 * n).astype(np.int64), 0, n - 1)
            t = self.tables[L][face[m], ty, tx]
            ok = t >= 0
            sel = np.flatnonzero(m)[ok]
            idx[sel] = t[ok]
            used[sel] = L
            todo[sel] = False
            if not todo.any():
                break
        span = 2.0 / (1 << used)
        tx = np.floor((a + 1) / span)
        ty = np.floor((b + 1) / span)
        fu = ((a + 1) / span - tx) * 256 + 1
        fv = ((b + 1) / span - ty) * 256 + 1
        i = np.clip(np.floor(fu).astype(np.int64), 0, 257)
        j = np.clip(np.floor(fv).astype(np.int64), 0, 257)
        txf = np.clip(fu - i, 0, 1)
        tyf = np.clip(fv - j, 0, 1)
        st = self.stack
        q00 = st[idx, j, i].astype(np.float64)
        q10 = st[idx, j, i + 1]
        q01 = st[idx, j + 1, i]
        q11 = st[idx, j + 1, i + 1]
        q = (q00 * (1 - txf) + q10 * txf) * (1 - tyf) + (q01 * (1 - txf) + q11 * txf) * tyf
        return self.base[idx] + q * self.step[idx], used


def dirs_to_face(d: np.ndarray):
    ad = np.abs(d)
    ax = np.argmax(ad, axis=-1)
    neg = np.take_along_axis(d, ax[..., None], -1)[..., 0] < 0
    face = ax * 2 + neg  # 0 +X, 1 -X, 2 +Y, 3 -Y, 4 +Z, 5 -Z
    N, U, V = FACES[face, 0], FACES[face, 1], FACES[face, 2]
    dn = np.sum(d * N, -1)
    s = np.sum(d * U, -1) / dn
    t = np.sum(d * V, -1) / dn
    return face, np.arctan(s) * 4 / np.pi, np.arctan(t) * 4 / np.pi


# ------------------------------------------------------------------ ephemeris
def load_ephem_year(y: int):
    b = (EPHEM / f"{y}.bin").read_bytes()
    _, _, jd0, step, n, nb = struct.unpack_from("<4sIddII", b, 0)
    return jd0, step, np.frombuffer(b, "<f4", n * nb * 6, 32).reshape(n, nb, 6).astype(np.float64)


def ref_year_bodies():
    """Sun / Earth vectors (km, Moon body frame) every 6 h through the reference year"""
    jd0, step, arr = load_ephem_year(REF_YEAR)
    t0 = np.datetime64(f"{REF_YEAR}-01-01T00:00")
    times = t0 + np.arange(0, 365 * 4) * np.timedelta64(6, "h")
    sun, earth = [], []
    for t in times:
        jd_utc = (t - np.datetime64("1970-01-01T00:00")) / np.timedelta64(1, "D") + 2440587.5
        jd = jd_utc + tdb_minus_utc_s(jd_utc) / 86400
        f = (jd - jd0) / step
        i = int(min(max(np.floor(f), 0), arr.shape[0] - 2))
        s = f - i
        h = step * 86400
        h00, h10, h01, h11 = 2 * s ** 3 - 3 * s ** 2 + 1, s ** 3 - 2 * s ** 2 + s, -2 * s ** 3 + 3 * s ** 2, s ** 3 - s ** 2
        st = h00 * arr[i, :, :3] + h10 * h * arr[i, :, 3:] + h01 * arr[i + 1, :, :3] + h11 * h * arr[i + 1, :, 3:]
        Mt = iau_moon(jd).T
        sun.append(Mt @ st[0])
        earth.append(Mt @ st[1])
    return np.array(sun), np.array(earth)


# ------------------------------------------------------------------ per tile
_T: Terrain | None = None
_SUN = _EARTH = None


def _init(levels, sun, earth):
    global _T, _SUN, _EARTH
    _T = Terrain(levels)
    _SUN, _EARTH = sun, earth


def disc_fraction(m, r):
    x = np.clip(m / r, -1, 1)
    return 1 - (np.arccos(x) - x * np.sqrt(1 - x * x)) / np.pi


def albedo(i_deg):
    return 0.12 + 0.06 * (i_deg / 45) ** 3 + 0.25 * (i_deg / 90) ** 8


def tile_samples(L, f, x, y):
    span = 2 / (1 << L)
    k = np.arange(S) / (S - 1)
    A, B = np.meshgrid(-1 + x * span + k * span, -1 + y * span + k * span)
    return geom.face_dirs(f, A, B).reshape(-1, 3)


def frames(up):
    east = np.cross(np.array([0.0, 0.0, 1.0]), up)
    n = np.linalg.norm(east, axis=-1, keepdims=True)
    east = np.where(n < 1e-9, np.array([0.0, 1.0, 0.0]), east / np.maximum(n, 1e-12))
    north = np.cross(up, east)
    return east, north


def along(up, east, north, az_deg, dist):
    a = np.radians(az_deg)
    th = dist / R
    hd = np.cos(a)[..., None] * north + np.sin(a)[..., None] * east
    return up * np.cos(th)[..., None] + hd * np.sin(th)[..., None]


def process_tile(key):
    L, f, x, y, child_mask = key
    out = TILES / "f" / str(L) / str(f) / str(y) / f"{x}.bin"
    if out.exists():
        return key, out.stat().st_size, True
    T = _T
    up = tile_samples(L, f, x, y)
    P = up.shape[0]
    east, north = frames(up)
    h0, lev0 = T.sample(up, 99)
    cell = texel(lev0)
    b = 2 * cell
    hs = [T.sample(along(up, east, north, np.full(P, az), b), lev0)[0] for az in (0, 90, 180, 270)]
    dzdn = (hs[0] - hs[2]) / (2 * b)
    dzde = (hs[1] - hs[3]) / (2 * b)
    slope = np.degrees(np.arctan(np.hypot(dzdn, dzde)))
    aspect = np.degrees(np.arctan2(-dzde, -dzdn)) % 360
    normal = up - east * dzde[:, None] - north * dzdn[:, None]
    normal /= np.linalg.norm(normal, axis=-1, keepdims=True)
    ring = np.mean([T.sample(along(up, east, north, np.full(P, az), np.full(P, RING_M)), lev0)[0]
                    for az in range(0, 360, 45)], axis=0)
    prominence = h0 - ring

    # ---- horizon (vectorised ray march over P * NAZ rays)
    azs = np.arange(NAZ) * (360.0 / NAZ)
    U = np.repeat(up, NAZ, 0)
    HD = (np.cos(np.radians(azs))[None, :, None] * north[:, None, :]
          + np.sin(np.radians(azs))[None, :, None] * east[:, None, :]).reshape(-1, 3)
    r0 = np.repeat(R + h0 + OBS_H, NAZ)
    best = np.full(P * NAZ, -np.pi / 2)
    active = np.arange(P * NAZ)
    d = max(2.0, 0.5 * float(cell.min()))
    rtop = R + H_MAX
    while d < 800e3 and active.size:
        th = d / R
        c, s = np.cos(th), np.sin(th)
        etop = np.arctan2(rtop * c - r0[active], rtop * s)
        active = active[etop >= best[active]]
        if not active.size:
            break
        Lr = int(max(0, np.ceil(np.log2(TEX0 / max(d * ANG, 1.0)))))
        dirs = U[active] * c + HD[active] * s
        hh, _ = T.sample(dirs, Lr)
        r1 = R + hh
        e = np.arctan2(r1 * c - r0[active], r1 * s)
        best[active] = np.maximum(best[active], e)
        d = d * 1.01 + 0.75 * float(texel(min(Lr, T.maxL)))
    horizon = np.degrees(best).reshape(P, NAZ)

    # ---- reference-year statistics
    site = up * (R + h0 + OBS_H)[:, None] / 1000.0  # km
    n_t = _SUN.shape[0]
    sun_sum = np.zeros(P)
    earth_sum = np.zeros(P)
    abs_sum = np.zeros(P)
    for t0 in range(0, n_t, 120):
        sl = slice(t0, min(n_t, t0 + 120))
        for body, rad in ((_SUN[sl], R_SUN_KM), (_EARTH[sl], R_EARTH_KM)):
            v = body[:, None, :] - site[None, :, :]  # (t, P, 3)
            dist = np.linalg.norm(v, axis=-1)
            u = v / dist[..., None]
            el = np.degrees(np.arcsin(np.clip(np.sum(u * up, -1), -1, 1)))
            az = np.degrees(np.arctan2(np.sum(u * east, -1), np.sum(u * north, -1))) % 360
            xb = az / (360.0 / NAZ)
            i0 = np.floor(xb).astype(np.int64) % NAZ
            i1 = (i0 + 1) % NAZ
            w = xb - np.floor(xb)
            pidx = np.arange(P)[None, :]
            hz = horizon[pidx, i0] * (1 - w) + horizon[pidx, i1] * w
            margin = el - hz
            if rad == R_SUN_KM:
                vf = disc_fraction(margin, np.degrees(np.arcsin(rad / dist)))
                sun_sum += vf.sum(0)
                ci = np.sum(u * normal, -1)
                flux = 1361.0 * (AU_KM / dist) ** 2
                inc = np.degrees(np.arccos(np.clip(ci, -1, 1)))
                abs_sum += np.where(ci > 0, (1 - albedo(inc)) * flux * ci * vf, 0).sum(0)
            else:
                earth_sum += (margin > 0).sum(0)

    def u16(v, scale):
        return np.clip(np.round(v * scale), 0, 65535).astype("<u2")

    asp = np.where(slope < 0.05, 65535, np.round(aspect * 100)).astype("<u2")
    payload = (
        np.clip(np.round(horizon * 4), -127, 127).astype(np.int8).tobytes()
        + np.clip(np.round(h0), -32768, 32767).astype("<i2").tobytes()
        + u16(slope, 100).tobytes()
        + asp.tobytes()
        + np.clip(np.round(prominence), -32768, 32767).astype("<i2").tobytes()
        + u16(sun_sum / n_t, 65535).tobytes()
        + u16(earth_sum / n_t, 65535).tobytes()
        + u16(abs_sum / n_t, 100).tobytes()
    )
    hdr = struct.pack("<4sBBBBIIHH", b"MLF1", L, f, child_mask, S, x, y, NAZ, 0)
    out.parent.mkdir(parents=True, exist_ok=True)
    blob = zlib.compress(hdr + payload, 6)
    tmp = out.with_suffix(".tmp")
    tmp.write_bytes(blob)
    tmp.replace(out)
    return key, len(blob), False


# ------------------------------------------------------------------ driver
def polar(L, f, x, y, lat0):
    lat, _ = geom.dirs_to_latlon(geom.tile_probe(L, f, x, y))
    return bool((np.abs(lat) >= lat0).any())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 4) - 4))
    ap.add_argument("--polar-lat", type=float, default=84.0)
    ap.add_argument("--polar-level", type=int, default=6)
    ap.add_argument("--global-level", type=int, default=3)
    a = ap.parse_args()
    t_all = time.time()
    store = build_store(6, a.polar_lat, 9)
    print("reference-year ephemeris ...", flush=True)
    sun, earth = ref_year_bodies()

    # score-tile quadtree
    levels = {}
    cur = [(0, f, 0, 0) for f in range(6)]
    for L in range(0, a.polar_level + 1):
        nxt = []
        rows = []
        for (_, f, x, y) in cur:
            kids = [(L + 1, f, 2 * x + cx, 2 * y + cy) for cy in (0, 1) for cx in (0, 1)]
            want = L + 1 <= a.global_level or (L + 1 <= a.polar_level and any(polar(*k, a.polar_lat) for k in kids))
            rows.append((L, f, x, y, 15 if want else 0))
            if want:
                nxt += kids
        levels[L] = rows
        cur = nxt
    total = sum(len(v) for v in levels.values())
    print(f"score tiles: {total} ({total * S * S / 1e6:.2f} M samples)", flush=True)

    with Pool(a.workers, initializer=_init, initargs=(store["levels"], sun, earth)) as pool:
        for L, rows in levels.items():
            t = time.time()
            nbytes = 0
            for _, size, _ in pool.imap_unordered(process_tile, rows, chunksize=1):
                nbytes += size
            print(f"F{L}: {len(rows):5d} tiles  {nbytes / 1e6:8.1f} MB  {time.time() - t:6.1f} s", flush=True)
    meta_p = TILES / "meta.json"
    meta = json.loads(meta_p.read_text())
    meta["feasibility"] = {"format": "MLF1", "samples": S, "azimuths": NAZ, "maxLevel": a.polar_level,
                           "globalLevel": a.global_level, "polarLat": a.polar_lat, "referenceYear": REF_YEAR}
    meta_p.write_text(json.dumps(meta, indent=1))
    print(f"done in {time.time() - t_all:.0f} s")


if __name__ == "__main__":
    main()
