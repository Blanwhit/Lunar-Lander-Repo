"""Tile pipeline driver.

    python -I pipeline/build.py overviews        # mip pyramids for every elevation source
    python -I pipeline/build.py heights [--max-level N] [--workers N]
    python -I pipeline/build.py colour  [--max-level N]
    python -I pipeline/build.py stars
    python -I pipeline/build.py meta
    python -I pipeline/build.py stats            # disk size per level
    python -I pipeline/build.py all

Everything is written to web/public/tiles/ (see config.json). Re-runs skip tiles that
already exist (delete the folder to rebuild).
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from collections import defaultdict
from multiprocessing import Pool
from pathlib import Path

os.environ.setdefault("OPENCV_IO_ENABLE_OPENEXR", "1")

import numpy as np  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
from moonlod import geom  # noqa: E402
from moonlod.heights import build_heights, child_mask, decode, encode  # noqa: E402
from moonlod.sources import load_sources  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CFG = json.loads((ROOT / "pipeline" / "config.json").read_text())
RAW = ROOT / CFG["raw_dir"]
CACHE = ROOT / CFG["cache_dir"]
OUT = ROOT / CFG["out_dir"]
BASISU = ROOT / "tools" / ("basisu.exe" if os.name == "nt" else "basisu")


def human(n: float) -> str:
    for u in ["B", "KB", "MB", "GB", "TB"]:
        if n < 1024:
            return f"{n:.1f} {u}"
        n /= 1024
    return f"{n:.1f} PB"


# ----------------------------------------------------------------- overviews
def cmd_overviews(args) -> None:
    for s in load_sources(CFG, RAW):
        t = time.time()
        s.build_overviews(CACHE)
        print(f"overviews {s.name}: {time.time() - t:.1f} s", flush=True)


# ------------------------------------------------------------------ heights
_SOURCES = None


def _init_worker(max_level: int) -> None:
    global _SOURCES
    cfg = dict(CFG)
    cfg["max_level"] = max_level
    _SOURCES = (load_sources(cfg, RAW), cfg)
    for s in _SOURCES[0]:
        s.open_levels(CACHE)


def _height_path(L: int, f: int, x: int, y: int) -> Path:
    return OUT / "h" / str(L) / str(f) / str(y) / f"{x}.bin"


def _build_one(key):
    L, f, x, y = key
    sources, cfg = _SOURCES
    p = _height_path(L, f, x, y)
    m = child_mask(sources, cfg, L, f, x, y)
    if p.exists():
        meta, _ = decode_header(p.read_bytes())
        if meta["child_mask"] == m:  # still valid for this max_level
            return key, p.stat().st_size, m, True
    cell = geom.tile_cell_size(L, f, x, y)
    h = build_heights(sources, L, f, x, y)
    blob = encode(L, f, x, y, h, m, cell)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_bytes(blob)
    tmp.replace(p)
    return key, len(blob), m, False


def decode_header(blob: bytes):
    import zlib
    from moonlod.heights import HEADER
    d = zlib.decompressobj()
    raw = d.decompress(blob, HEADER.size)
    f = HEADER.unpack_from(raw, 0)
    return {"child_mask": f[3], "hmin": f[8], "hmax": f[9]}, None


def cmd_heights(args) -> None:
    max_level = args.max_level if args.max_level is not None else CFG["max_level"]
    todo = [(0, f, 0, 0) for f in range(6)]
    stats = {}
    t_all = time.time()
    with Pool(args.workers, initializer=_init_worker, initargs=(max_level,)) as pool:
        L = 0
        while todo and L <= max_level:
            t = time.time()
            nxt = []
            nbytes = 0
            skipped = 0
            for i, (key, size, mask, skip) in enumerate(pool.imap_unordered(_build_one, todo, chunksize=4)):
                nbytes += size
                skipped += skip
                _, f, x, y = key
                if L < max_level:
                    for c in range(4):
                        if mask & (1 << c):
                            nxt.append((L + 1, f, 2 * x + (c & 1), 2 * y + (c >> 1)))
                if (i + 1) % 2000 == 0:
                    print(f"   L{L}: {i + 1}/{len(todo)}", flush=True)
            stats[L] = {"tiles": len(todo), "bytes": nbytes}
            print(f"L{L:2d}: {len(todo):7d} tiles  {human(nbytes):>10s}  "
                  f"avg {human(nbytes / len(todo)):>9s}  cell~{geom.tile_cell_size(L, 0, 0, 0) if L else 10660:.0f} m"
                  f"  ({skipped} existing)  {time.time() - t:.1f} s", flush=True)
            todo = sorted(nxt)
            L += 1
    tot = sum(v["bytes"] for v in stats.values())
    print(f"heights total: {sum(v['tiles'] for v in stats.values())} tiles, {human(tot)}, {time.time() - t_all:.0f} s")


# ------------------------------------------------------------------- colour
def read_exr_rgb(path: Path) -> np.ndarray:
    """OpenEXR (ASWF bindings) -> (H, W, 3) float16/32 RGB array."""
    import OpenEXR
    with OpenEXR.File(str(path)) as f:
        ch = f.channels()
        if "RGB" in ch:
            return np.asarray(ch["RGB"].pixels)
        return np.stack([np.asarray(ch[c].pixels) for c in "RGB"], axis=-1)


def load_colour_srgb() -> np.ndarray:
    """EXR (linear half RGB) -> cached sRGB uint8 (H, W, 3) memmap."""
    path = CACHE / "colour_srgb.u8"
    meta = CACHE / "colour_srgb.json"
    if path.exists() and meta.exists():
        m = json.loads(meta.read_text())
        return np.memmap(path, dtype=np.uint8, mode="r", shape=(m["h"], m["w"], 3))
    t = time.time()
    img = read_exr_rgb(RAW / CFG["colour"]["exr"])
    h, w = img.shape[:2]
    sub = img[::16, ::16].astype(np.float32)
    ref = float(np.percentile(sub.mean(axis=2), CFG["colour"]["exposure_percentile"]))
    scale = CFG["colour"]["white"] / max(ref, 1e-6)
    print(f"colour EXR {w}x{h}: p{CFG['colour']['exposure_percentile']}={ref:.4f} -> scale {scale:.3f}")
    CACHE.mkdir(parents=True, exist_ok=True)
    out = np.memmap(path.with_suffix(".tmp"), dtype=np.uint8, mode="w+", shape=(h, w, 3))
    for r in range(0, h, 1024):
        v = np.clip(img[r:r + 1024].astype(np.float32) * scale, 0, 1)
        s = np.where(v <= 0.0031308, v * 12.92, 1.055 * np.power(v, 1 / 2.4) - 0.055)
        out[r:r + 1024] = np.round(s * 255).astype(np.uint8)
    out.flush()
    del out, img
    path.with_suffix(".tmp").replace(path)
    meta.write_text(json.dumps({"h": h, "w": w, "scale": scale}))
    print(f"  cached sRGB colour in {time.time() - t:.0f} s")
    return np.memmap(path, dtype=np.uint8, mode="r", shape=(h, w, 3))


def colour_pyramid(base: np.ndarray, levels: int) -> list[np.ndarray]:
    """linear-light 2x2 box pyramid of the sRGB map, cached as uint8 sRGB memmaps."""
    import cv2
    pyr = [base]
    cur = base
    for k in range(1, levels + 1):
        h, w = cur.shape[0] // 2, cur.shape[1] // 2
        path = CACHE / f"colour_srgb_ov{k}.u8"
        if not path.exists():
            lin = (np.asarray(cur).astype(np.float32) / 255.0) ** 2.2
            lin = cv2.resize(lin, (w, h), interpolation=cv2.INTER_AREA)
            arr = np.round(np.clip(lin, 0, 1) ** (1 / 2.2) * 255).astype(np.uint8)
            tmp = path.with_suffix(".tmp")
            arr.tofile(tmp)
            tmp.replace(path)
        cur = np.memmap(path, dtype=np.uint8, mode="r", shape=(h, w, 3))
        pyr.append(cur)
    return pyr


_PYR = None


def _colour_init() -> None:
    global _PYR
    _PYR = colour_pyramid(load_colour_srgb(), 7)


def _colour_one(key) -> str:
    from PIL import Image
    L, f, x, y = key
    A, B = geom.colour_ab(L, x, y)
    lat, lon = geom.dirs_to_latlon(geom.face_dirs(f, A, B))
    rgb = sample_colour(_PYR, lat, lon, geom.local_cell(L, A, B, geom.COLOUR_N - 1))
    p = CACHE / "colour_png" / f"{L}_{f}_{y}_{x}.png"
    Image.fromarray(rgb).save(p)
    return str(p)


def _sample_colour_level(img: np.ndarray, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    """bilinear sample (linear light, float32 RGB) of one pyramid level."""
    H, W = img.shape[:2]
    # map centred on 0 deg longitude: column 0 at lon -180 (verified, see DATA_SOURCES.md)
    col = ((lon + 180.0) % 360.0) / 360.0 * W - 0.5
    row = (90.0 - lat) / 180.0 * H - 0.5
    c0 = np.floor(col).astype(np.int64)
    r0 = np.clip(np.floor(row).astype(np.int64), 0, H - 2)
    fc = (col - c0)[..., None].astype(np.float32)
    fr = np.clip(row - r0, 0, 1)[..., None].astype(np.float32)
    c1 = (c0 + 1) % W
    c0 = c0 % W
    lut = (np.arange(256, dtype=np.float32) / 255.0) ** 2.2
    g = lambda r, c: lut[img[r, c]]  # noqa: E731
    return (g(r0, c0) * (1 - fc) + g(r0, c1) * fc) * (1 - fr) + (g(r0 + 1, c0) * (1 - fc) + g(r0 + 1, c1) * fc) * fr


def sample_colour(pyr: list[np.ndarray], lat: np.ndarray, lon: np.ndarray, cell_m: np.ndarray) -> np.ndarray:
    """trilinear (per-pixel footprint) colour sample -> sRGB uint8."""
    W0 = pyr[0].shape[1]
    res0 = np.pi * geom.R_MOON * 2 / W0
    kf = np.clip(np.log2(np.maximum(cell_m, 1e-9) / res0), 0, len(pyr) - 1)
    k0 = np.floor(kf).astype(np.int64)
    t = (kf - k0)[..., None].astype(np.float32)
    out = np.zeros(lat.shape + (3,), np.float32)
    levels = {k: _sample_colour_level(pyr[k], lat, lon) for k in range(int(k0.min()), min(len(pyr) - 1, int(k0.max()) + 1) + 1)}
    for k in np.unique(k0):
        m = k0 == k
        a = levels[int(k)][m]
        b = levels[min(int(k) + 1, len(pyr) - 1)][m]
        out[m] = a * (1 - t[m]) + b * t[m]
    return np.round(np.clip(out, 0, 1) ** (1 / 2.2) * 255).astype(np.uint8)


def _basisu(files: list[Path], out_dir: Path, extra: list[str]) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = [str(BASISU), "-ktx2", "-mipmap", "-output_path", str(out_dir), *extra, *map(str, files)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stdout[-2000:] + r.stderr[-2000:])


def cmd_colour(args) -> None:
    max_level = args.max_level if args.max_level is not None else CFG["colour_max_level"]
    _colour_init()  # builds / caches the pyramid once in the parent
    png_dir = CACHE / "colour_png"
    png_dir.mkdir(parents=True, exist_ok=True)
    ktx_tmp = CACHE / "colour_ktx2"
    from concurrent.futures import ThreadPoolExecutor
    with Pool(args.workers, initializer=_colour_init) as pool:
        for L in range(max_level + 1):
            t = time.time()
            n = 1 << L
            keys = [(L, f, x, y) for f in range(6) for y in range(n) for x in range(n)
                    if not (OUT / "c" / str(L) / str(f) / str(y) / f"{x}.ktx2").exists()]
            pngs = [Path(p) for p in pool.imap_unordered(_colour_one, keys, chunksize=8)]
            batches = [pngs[i:i + 48] for i in range(0, len(pngs), 48)]
            with ThreadPoolExecutor(max(1, min(8, os.cpu_count() or 4))) as ex:
                list(ex.map(lambda b: _basisu(b, ktx_tmp, CFG["colour"]["basis"]), batches))
            for p in pngs:
                _, f, y, x = p.stem.split("_")
                dst = OUT / "c" / str(L) / f / y / f"{x}.ktx2"
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(ktx_tmp / (p.stem + ".ktx2"), dst)
                p.unlink()
            nbytes = sum(p.stat().st_size for p in (OUT / "c" / str(L)).rglob("*.ktx2"))
            print(f"colour L{L}: {6 * n * n:6d} tiles {human(nbytes):>10s}  {time.time() - t:.1f} s", flush=True)


# -------------------------------------------------------------------- stars
def cmd_stars(args) -> None:
    import cv2
    from PIL import Image
    img = read_exr_rgb(RAW / CFG["stars"]["exr"]).astype(np.float32)
    H, W = img.shape[:2]
    lum = img.mean(axis=2)
    p50, p99, p9999 = np.percentile(lum, [50, 99, 99.99])
    print(f"star map {W}x{H}: p50 {p50:.4g} p99 {p99:.4g} p99.99 {p9999:.4g}")
    # display transform: black point at the median sky (so the background is black and
    # compresses well), mild gain so the Milky Way stays a faint glow; stars saturate.
    bp = float(p50)
    gain = CFG["stars"].get("gain", 1.2)

    def tone(v):
        v = np.clip((v - bp) * gain, 0, 1)
        return np.where(v <= 0.0031308, v * 12.92, 1.055 * np.power(v, 1 / 2.4) - 0.055)

    files = []
    for size in CFG["stars"]["face_sizes"]:
        faces = []
        s = (np.arange(size) + 0.5) / size * 2 - 1
        sc, tc = np.meshgrid(s, s)  # row = t, col = s
        one = np.ones_like(sc)
        # OpenGL cube map conventions (row 0 = t = -1 side)
        dirs = [
            np.stack([one, -tc, -sc], -1),   # +X
            np.stack([-one, -tc, sc], -1),   # -X
            np.stack([sc, one, tc], -1),     # +Y
            np.stack([sc, -one, -tc], -1),   # -Y
            np.stack([sc, -tc, one], -1),    # +Z
            np.stack([-sc, -tc, -one], -1),  # -Z
        ]
        # area-filter the source to roughly the face resolution
        src_res = 360.0 / W
        face_res = 90.0 / size
        src = img
        if face_res > 1.5 * src_res:
            f = int(face_res / src_res)
            src = cv2.resize(img, (W // f, H // f), interpolation=cv2.INTER_AREA)
        h2, w2 = src.shape[:2]
        for fi, d in enumerate(dirs):
            d = d / np.linalg.norm(d, axis=-1, keepdims=True)
            dec = np.degrees(np.arcsin(np.clip(d[..., 2], -1, 1)))
            ra = np.degrees(np.arctan2(d[..., 1], d[..., 0])) % 360
            # map centred on RA 0h, RA increasing to the left
            col = ((180.0 - ra) % 360.0) / 360.0 * w2 - 0.5
            row = (90.0 - dec) / 180.0 * h2 - 0.5
            v = cv2.remap(src, col.astype(np.float32), row.astype(np.float32), cv2.INTER_LINEAR,
                          borderMode=cv2.BORDER_WRAP)
            rgb = np.round(np.clip(tone(v), 0, 1) * 255).astype(np.uint8)
            p = CACHE / "stars" / f"stars{size}_{fi}.png"
            p.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(rgb).save(p)
            faces.append(p)
        out_dir = CACHE / "stars_ktx2"
        mode = CFG["stars"].get("basis_hi", ["-uastc", "-uastc_level", "2", "-uastc_rdo_l", "2.0"]) if size > 1024 else ["-q", "255"]
        _basisu(faces, out_dir, ["-tex_type", "cubemap", "-linear", *mode])
        produced = out_dir / (faces[0].stem + ".ktx2")
        dst = OUT / f"stars_{size}.ktx2"
        OUT.mkdir(parents=True, exist_ok=True)
        shutil.move(produced, dst)
        files.append(dst.name)
        print(f"stars {size}: {human(dst.stat().st_size)}")
    (CACHE / "stars_files.json").write_text(json.dumps(files))


# --------------------------------------------------------------------- meta
def cmd_meta(args) -> None:
    stars = []
    sf = CACHE / "stars_files.json"
    if sf.exists():
        stars = json.loads(sf.read_text())
    max_level = 0
    for p in (OUT / "h").iterdir() if (OUT / "h").exists() else []:
        max_level = max(max_level, int(p.name))
    meta = {
        "format": "MLH1",
        "maxLevel": max_level,
        "colourMaxLevel": max((int(p.name) for p in (OUT / "c").iterdir()), default=0) if (OUT / "c").exists() else 0,
        "tileN": geom.TILE_N,
        "grid": geom.GRID,
        "radius": geom.R_MOON,
        "stars": stars,
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "meta.json").write_text(json.dumps(meta, indent=1))
    print(json.dumps(meta))


def cmd_stats(args) -> None:
    rows = defaultdict(lambda: [0, 0, 0, 0])
    for kind, idx in (("h", 0), ("c", 2)):
        base = OUT / kind
        if not base.exists():
            continue
        for lv in base.iterdir():
            for p in lv.rglob("*"):
                if p.is_file():
                    rows[int(lv.name)][idx] += 1
                    rows[int(lv.name)][idx + 1] += p.stat().st_size
    print(f"{'level':>5} {'~m/px':>8} {'height tiles':>13} {'height size':>12} {'colour tiles':>13} {'colour size':>12}")
    th = tc = 0
    for L in sorted(rows):
        a = rows[L]
        th += a[1]
        tc += a[3]
        print(f"{L:5d} {geom.R_MOON * np.pi / 2 / 256 / 2 ** L:8.1f} {a[0]:13d} {human(a[1]):>12s} {a[2]:13d} {human(a[3]):>12s}")
    other = sum(p.stat().st_size for p in OUT.glob("*.*"))
    print(f"total heights {human(th)}, colour {human(tc)}, other {human(other)}; all {human(th + tc + other)}")
    l0 = rows.get(0, [0, 0, 0, 0])
    print(f"level-0 payload (6 height + 6 colour tiles): {human(l0[1] + l0[3])}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["overviews", "heights", "colour", "stars", "meta", "stats", "all"])
    ap.add_argument("--max-level", type=int, default=None)
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 4) - 4))
    args = ap.parse_args()
    if args.cmd == "all":
        for c in (cmd_overviews, cmd_heights, cmd_colour, cmd_stars, cmd_meta, cmd_stats):
            c(args)
    else:
        globals()[f"cmd_{args.cmd}"](args)


if __name__ == "__main__":
    main()
