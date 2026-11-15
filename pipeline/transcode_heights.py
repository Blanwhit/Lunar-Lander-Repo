"""Convert already-built height data to the smaller lossless codec, in place, so nothing
has to be rebuilt from the raw DEMs:

  * web/public/tiles/h/**.bin   MLH1 (zlib)          -> MLH2 (moonlod.gridcodec)
  * web/public/walk-terrain/**  deflate planar grids -> MWG2 (moonlod.gridcodec)

    python -I pipeline/transcode_heights.py [--workers N]

Every converted file is decoded again and compared with the original quantised grid
before it replaces the original, so the conversion is bit-exact or it stops. Files
already in the new format are skipped, so an interrupted run can simply be restarted.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import zlib
from multiprocessing import Pool
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from moonlod.gridcodec import decode_grid, encode_grid  # noqa: E402
from moonlod.heights import HEADER, MAGIC  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
TILES = ROOT / "web/public/tiles"
WALK = ROOT / "web/public/walk-terrain"
WALK_MAGIC = b"MWG2"


def _planar_inverse(raw: bytes, offset: int, h: int, w: int) -> np.ndarray:
    lo, hi = np.frombuffer(raw, np.uint8, 2 * h * w, offset).reshape(2, h, w).astype(np.int64)
    z = lo | hi << 8
    return ((z >> 1) ^ -(z & 1)).cumsum(1).cumsum(0) & 0xFFFF


def _replace(path: Path, blob: bytes) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(blob)
    for attempt in range(20):  # Windows refuses the rename while a server has the file open
        try:
            tmp.replace(path)
            return
        except PermissionError:
            if attempt == 19:
                tmp.unlink(missing_ok=True)
                raise
            time.sleep(0.25 * (attempt + 1))


def convert_tile(path: Path) -> tuple[int, int]:
    blob = path.read_bytes()
    if blob[:4] == MAGIC:
        return len(blob), len(blob)
    raw = zlib.decompress(blob)
    f = list(HEADER.unpack_from(raw, 0))
    if f[0] != b"MLH1":
        raise ValueError(f"{path}: unknown tile format {f[0]!r}")
    G = f[11]
    q = _planar_inverse(raw, HEADER.size, G, G)
    f[0] = MAGIC
    body = encode_grid(q)
    if not np.array_equal(decode_grid(body, G, G, signed=False), q):
        raise RuntimeError(f"{path}: round trip mismatch, original kept")
    _replace(path, HEADER.pack(*f) + body)
    return len(blob), HEADER.size + len(body)


def convert_walk(path: Path) -> tuple[int, int]:
    blob = path.read_bytes()
    if blob[:4] == WALK_MAGIC:
        return len(blob), len(blob)
    raw = zlib.decompress(blob)
    w = int(round((len(raw) // 2) ** 0.5))
    if 2 * w * w != len(raw):
        raise ValueError(f"{path}: not a square grid")
    q = ((_planar_inverse(raw, 0, w, w) + 32768) & 0xFFFF) - 32768  # signed int16
    body = encode_grid(q)
    if not np.array_equal(decode_grid(body, w, w, signed=True), q):
        raise RuntimeError(f"{path}: round trip mismatch, original kept")
    _replace(path, WALK_MAGIC + body)
    return len(blob), 4 + len(body)


def run(label: str, fn, paths: list[Path], workers: int) -> None:
    if not paths:
        return
    t0 = time.time()
    before = after = 0
    with Pool(workers) as pool:
        for i, (b, a) in enumerate(pool.imap_unordered(fn, paths, chunksize=8), 1):
            before += b
            after += a
            if i % 2000 == 0 or i == len(paths):
                print(f"  {label}: {i}/{len(paths)}  {before / 1e6:.1f} MB -> {after / 1e6:.1f} MB "
                      f"({100 * after / before:.1f}%), {time.time() - t0:.0f} s", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=os.cpu_count())
    args = ap.parse_args()
    walk = sorted(p for p in WALK.rglob("*.bin"))
    run("walk-terrain", convert_walk, walk, args.workers)
    tiles = sorted((TILES / "h").rglob("*.bin")) if (TILES / "h").exists() else []
    run("height tiles", convert_tile, tiles, args.workers)
    meta = TILES / "meta.json"
    if tiles and meta.exists():
        m = json.loads(meta.read_text())
        if m.get("format") != MAGIC.decode():
            m["format"] = MAGIC.decode()
            meta.write_text(json.dumps(m, indent=1))


if __name__ == "__main__":
    main()
