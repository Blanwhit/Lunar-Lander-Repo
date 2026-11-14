"""Stage 1: inspect downloaded rasters.

* prints label-derived geometry, value range, nodata fraction for each source
* verifies the polar-stereographic orientation of every polar DEM by comparing it
  with the global LOLA grid (LDEM_64) over random points inside its cap, for all
  4 axis-flip candidates; the RMS-best one must be (1, 1) = config default
* checks SLDEM2015 vs LDEM_64 bias (both are relative to 1737.4 km)
* writes quicklook PNGs to data/inspect/

Run:  python -I pipeline/inspect_data.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from moonlod.sources import Source  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CFG = json.loads((ROOT / "pipeline" / "config.json").read_text())
RAW = ROOT / CFG["raw_dir"]
OUT = ROOT / "data" / "inspect"


def stats(src: Source) -> dict:
    a = src.level0()
    step = max(1, int(np.sqrt(a.size / 4e6)))
    sub = src._to_metres(np.asarray(a[::step, ::step]))
    fin = np.isfinite(sub)
    return {
        "shape": [src.height, src.width], "dtype": src.dtype, "res_m": round(src.res_m, 2),
        "proj": src.proj, "lat": [src.lat_min, src.lat_max],
        "min_m": float(np.nanmin(sub)), "max_m": float(np.nanmax(sub)),
        "mean_m": float(np.nanmean(sub)), "nodata_frac": float(1 - fin.mean()),
    }


def quicklook(src: Source, path: Path) -> None:
    from PIL import Image
    a = src.level0()
    step = max(1, max(a.shape) // 2048)
    sub = src._to_metres(np.asarray(a[::step, ::step]))
    lo, hi = np.nanpercentile(sub, [1, 99])
    img = np.clip((sub - lo) / (hi - lo) * 255, 0, 255)
    img = np.nan_to_num(img, nan=0).astype(np.uint8)
    Image.fromarray(img).save(path)


def compare(ref: Source, src: Source, lat_lo: float, lat_hi: float, n: int = 20000, seed: int = 1):
    rng = np.random.default_rng(seed)
    # uniform on the sphere band
    z = rng.uniform(np.sin(np.radians(lat_lo)), np.sin(np.radians(lat_hi)), n)
    lat = np.degrees(np.arcsin(z))
    lon = rng.uniform(0, 360, n)
    cell = max(ref.res_m, src.res_m) * 2
    a = ref.sample(lat, lon, cell)
    b = src.sample(lat, lon, cell)
    ok = np.isfinite(a) & np.isfinite(b)
    d = (b - a)[ok]
    return float(np.sqrt(np.mean(d ** 2))), float(np.mean(d)), int(ok.sum())


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    cache = ROOT / CFG["cache_dir"]
    report = {}
    srcs = {}
    for s in CFG["elevation_sources"]:
        img, lbl = RAW / s["img"], RAW / s["lbl"]
        if not (img.exists() and lbl.exists()) or (RAW / (s["img"] + ".parts.json")).exists():
            print(f"-- {s['name']}: not downloaded yet")
            continue
        src = Source.from_label(s["name"], lbl, img)
        src.open_levels(cache)  # overviews optional here
        srcs[s["name"]] = src
        st = stats(src)
        report[s["name"]] = st
        print(f"{s['name']:9s} {json.dumps(st)}")
        quicklook(src, OUT / f"{s['name']}.png")

    ref = srcs.get("ldem64")
    if ref is not None:
        for name, src in srcs.items():
            if src.proj == "polar":
                cap = (src.lat_min, src.lat_min + 8) if src.pole > 0 else (src.lat_max - 8, src.lat_max)
                if src.pole < 0:
                    cap = (max(-89.5, src.lat_max - 8), src.lat_max)
                else:
                    cap = (src.lat_min, min(89.5, src.lat_min + 8))
                res = {}
                for flip in [(1, 1), (-1, 1), (1, -1), (-1, -1)]:
                    src.polar_flip = flip
                    res[str(flip)] = compare(ref, src, *cap)
                best = min(res, key=lambda k: res[k][0])
                report[name]["orientation_rms_vs_ldem64"] = res
                report[name]["best_flip"] = best
                print(f"  {name}: orientation RMS vs LDEM_64 {res} -> best {best}")
                src.polar_flip = (1, 1)
            elif name == "sldem128":
                r = compare(ref, src, -59, 59)
                report[name]["vs_ldem64"] = {"rms": r[0], "bias": r[1], "n": r[2]}
                print(f"  sldem128 vs ldem64: rms {r[0]:.1f} m, bias {r[1]:.2f} m")
    (OUT / "report.json").write_text(json.dumps(report, indent=1))
    print(f"report -> {OUT / 'report.json'}")


if __name__ == "__main__":
    main()
