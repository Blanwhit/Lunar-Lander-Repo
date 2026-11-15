"""Export compact whole-Moon and landing-site height grids from the built MLH1 pyramid.

Run after make tiles with the repository's Python environment. All heights are metres
relative to the same LOLA reference sphere as the orbital viewer. Walking patches use
a tangent-plane (gnomonic) projection with positive x east and positive z south.
"""
from __future__ import annotations

import json
import zlib
from functools import lru_cache
from pathlib import Path

import numpy as np

from moonlod import geom
from moonlod.heights import HEADER

ROOT = Path(__file__).resolve().parents[1]
TILES = ROOT / "web/public/tiles/h"
OUT = ROOT / "web/public/walk-terrain"
GLOBAL_LEVEL = 2


@lru_cache(maxsize=64)
def read_tile(level: int, face: int, x: int, y: int) -> np.ndarray:
    raw = zlib.decompress((TILES / str(level) / str(face) / str(y) / f"{x}.bin").read_bytes())
    magic, l, f, _, _, tx, ty, _, _, step, base, grid, _ = HEADER.unpack_from(raw)
    if (magic, l, f, tx, ty, grid) != (b"MLH1", level, face, x, y, geom.GRID):
        raise ValueError(f"Invalid tile at {level}/{face}/{y}/{x}")
    lo, hi = np.frombuffer(raw, np.uint8, offset=HEADER.size).reshape(2, grid, grid).astype(np.int32)
    zig = lo | hi << 8
    diff = (zig >> 1) ^ -(zig & 1)
    values = diff.cumsum(axis=1).cumsum(axis=0) & 65535
    return np.asarray(base + step * values, dtype=np.float32)


def write_grid(filename: str, values: np.ndarray, step: float = 1, offset: int | None = None) -> dict:
    """Losslessly delta-code signed, quantized heights for the browser's deflate decoder."""
    if offset is None:
        offset = int(np.rint((float(values.min()) + float(values.max())) / 2))
    q = np.rint((values - offset) / step).astype(np.int32)
    if q.min() < -32768 or q.max() > 32767:
        raise ValueError(f"height range exceeds signed int16 for {filename}")
    diff = np.diff(q, axis=1, prepend=np.zeros_like(q[:, :1]))
    diff = np.diff(diff, axis=0, prepend=np.zeros_like(diff[:1]))
    diff = ((diff + 32768) % 65536) - 32768
    zig = ((diff << 1) ^ (diff >> 15)).astype(np.uint16)
    planes = np.stack((zig & 255, zig >> 8)).astype(np.uint8)
    (OUT / filename).write_bytes(zlib.compress(planes.tobytes(), 9))
    return {"file": filename, "width": q.shape[1], "step": step, "offset": offset}


def globe() -> list[dict]:
    n = 1 << GLOBAL_LEVEL
    side = geom.TILE_N * n + 1
    faces = np.empty((6, side, side), dtype=np.float32)
    for f in range(6):
        for y in range(n):
            for x in range(n):
                j, i = y * geom.TILE_N, x * geom.TILE_N
                faces[f, j:j+257, i:i+257] = read_tile(GLOBAL_LEVEL, f, x, y)[1:-1, 1:-1]
    # Adjacent tiles can use different native quantization. Give physically shared
    # cube vertices exactly one height, including the eight triple-face corners.
    edge_points: dict[tuple, list] = {}
    for f in range(6):
        rows, cols = np.where(np.pad(np.zeros((side-2, side-2), bool), 1, constant_values=True))
        dirs = geom.face_dirs(f, cols * 2 / (side-1) - 1, rows * 2 / (side-1) - 1)
        for row, col, direction in zip(rows, cols, dirs):
            edge_points.setdefault(tuple(direction.round(10)), []).append((f, row, col))
    for group in edge_points.values():
        shared = np.rint(np.mean([faces[key] for key in group]))
        for key in group:
            faces[key] = shared
    return [write_grid(f"face-{f}.bin", face) for f, face in enumerate(faces)]


def native_samples(dirs: np.ndarray, level: int) -> np.ndarray:
    """Sample at the requested level, descending to available ancestors at LOD cutoffs."""
    axes = np.argmax(np.abs(dirs), axis=-1)
    dominant = np.take_along_axis(dirs, axes[..., None], axis=-1)[..., 0]
    faces = 2 * axes + (dominant < 0)
    out = np.empty(axes.shape, np.float32)
    n = 1 << level
    for f in np.unique(faces):
        mask = faces == f
        d = dirs[mask]
        normal, u, v = geom.FACES[f]
        uv = (np.arctan2(d @ np.stack((u, v), axis=1), (d @ normal)[:, None]) * 4 / np.pi + 1) * n / 2
        tx, ty = np.clip(np.floor(uv).astype(int), 0, n-1).T
        keys = ty * n + tx
        sampled = np.empty(len(d), np.float32)
        for key in np.unique(keys):
            sub = keys == key
            y, x = divmod(int(key), n)
            l, scale = level, 1
            while not (TILES / str(l) / str(f) / str(y) / f"{x}.bin").is_file() and l:
                x, y, l, scale = x//2, y//2, l-1, scale*2
            tile = read_tile(l, int(f), x, y)
            px = np.clip((uv[sub] / scale - [x, y]) * geom.TILE_N, 0, geom.TILE_N) + 1
            ix, iy = np.floor(px).astype(int).T
            fx, fy = (px - np.floor(px)).T
            sampled[sub] = ((1-fy)*((1-fx)*tile[iy,ix]+fx*tile[iy,ix+1])
                            + fy*((1-fx)*tile[iy+1,ix]+fx*tile[iy+1,ix+1]))
        out[mask] = sampled
    return out


def patch(name: str, lat: float, lon: float, size: int, spacing: float, level: int) -> dict:
    up = geom.latlon_to_dir(lat, lon)
    east = np.array([-np.sin(np.radians(lon)), np.cos(np.radians(lon)), 0])
    south = np.cross(east, up)
    axis = (np.arange(size) - (size-1)/2) * spacing
    heights = np.empty((size, size), np.float32)
    for j in range(0, size, 64):
        zs = axis[j:j+64]
        dirs = geom.R_MOON * up + axis[None,:,None] * east + zs[:,None,None] * south
        heights[j:j+len(zs)] = native_samples(dirs, level)
    return {**write_grid(name + ".bin", heights, 0.25), "lat": lat, "lon": lon, "spacing": spacing}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = {"faces": globe(), "patches": [
        patch("taurus-littrow", 20.1908, 30.7717, 257, 256, 6),
        patch("tycho", -43.31, -11.36, 257, 256, 6),
        patch("south-pole", -89.33, 129.8, 513, 96, 8),
        patch("shackleton-rim", -89.33, 129.8, 1025, 5.25, 11),
    ]}
    (OUT / "index.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Exported {sum(p.stat().st_size for p in OUT.iterdir())/1e6:.2f} MB to {OUT}")


if __name__ == "__main__":
    main()
