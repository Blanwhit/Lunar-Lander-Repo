"""Height-tile construction and encoding.

File format (`tiles/h/{L}/{face}/{y}/{x}.bin`) -- the whole file is a zlib stream
(decoded in the browser with DecompressionStream('deflate')):

    off  type      field
    0    char[4]   magic "MLH1"
    4    u8        level
    5    u8        face
    6    u8        child mask (bit i set -> child i exists; i = (cy << 1) | cx)
    7    u8        flags (reserved, 0)
    8    u32       x
    12   u32       y
    16   f32       h_min  (m, over the 257x257 interior vertices)
    20   f32       h_max  (m)
    24   f32       step   (m per quantum)
    28   f32       base   (m)   height = base + q * step
    32   u16       grid size G (= 259)
    34   u16       reserved
    36   u8[G*G]   low bytes  \\  of zigzag(q - pred), pred = left + up - upleft
    ...  u8[G*G]   high bytes /   (row-major; first row/col predict from left/up)

All heights are metres relative to the 1737.4 km sphere.
"""
from __future__ import annotations

import struct
import zlib

import numpy as np

from .geom import GRID, R_MOON, dirs_to_latlon, height_grid, tile_cell_size, tile_probe

MAGIC = b"MLH1"
HEADER = struct.Struct("<4sBBBBIIffffHH")


def composite_heights(sources, lat, lon, cell_m: float) -> np.ndarray:
    h = None
    for s in sources:
        w = s.weight(lat).astype(np.float32)
        if not (w > 0).any():
            continue
        v = s.sample(lat, lon, cell_m)
        ok = np.isfinite(v)
        w = np.where(ok, w, 0.0).astype(np.float32)
        v = np.where(ok, v, 0.0)
        if h is None:
            h = np.where(ok, v, np.nan).astype(np.float32)
            continue
        hv = np.isfinite(h)
        # where nothing so far, take this source fully if it has data
        h = np.where(hv, h * (1 - w) + v * w, np.where(ok, v, np.nan))
    if h is None or not np.isfinite(h).all():
        bad = 0 if h is None else int((~np.isfinite(h)).sum())
        raise RuntimeError(f"holes in composite ({bad} samples)")
    return h.astype(np.float32)


def build_heights(sources, level: int, face: int, x: int, y: int) -> np.ndarray:
    d = height_grid(level, face, x, y)
    lat, lon = dirs_to_latlon(d)
    cell = tile_cell_size(level, face, x, y)
    return composite_heights(sources, lat, lon, cell)


def step_for_level(cell_m: float) -> float:
    s = 2.0 ** np.round(np.log2(cell_m / 256.0))
    return float(np.clip(s, 1.0 / 32.0, 0.5))


def encode(level: int, face: int, x: int, y: int, h: np.ndarray, child_mask: int, cell_m: float) -> bytes:
    G = h.shape[0]
    inner = h[1:-1, 1:-1]
    hmin, hmax = float(inner.min()), float(inner.max())
    lo, hi = float(h.min()), float(h.max())
    step = step_for_level(cell_m)
    while (hi - lo) / step > 65000:
        step *= 2
    base = np.floor(lo / step) * step
    q = np.round((h.astype(np.float64) - base) / step).astype(np.int64)
    assert q.min() >= 0 and q.max() <= 65535
    # planar prediction (mod 2^16)
    pred = np.zeros_like(q)
    pred[0, 1:] = q[0, :-1]
    pred[1:, 0] = q[:-1, 0]
    pred[1:, 1:] = q[1:, :-1] + q[:-1, 1:] - q[:-1, :-1]
    r = ((q - pred) & 0xFFFF).astype(np.uint16).view(np.int16).astype(np.int32)
    z = ((r << 1) ^ (r >> 15)) & 0xFFFF
    z = z.astype(np.uint16)
    payload = (z & 0xFF).astype(np.uint8).tobytes() + (z >> 8).astype(np.uint8).tobytes()
    hdr = HEADER.pack(MAGIC, level, face, child_mask, 0, x, y, hmin, hmax, step, base, G, 0)
    return zlib.compress(hdr + payload, 9)


def decode(blob: bytes) -> tuple[dict, np.ndarray]:
    raw = zlib.decompress(blob)
    f = HEADER.unpack_from(raw, 0)
    meta = dict(zip(["magic", "level", "face", "child_mask", "flags", "x", "y", "hmin", "hmax", "step", "base", "G", "_"], f))
    G = meta["G"]
    n = G * G
    lo = np.frombuffer(raw, np.uint8, n, HEADER.size).astype(np.int32)
    hi = np.frombuffer(raw, np.uint8, n, HEADER.size + n).astype(np.int32)
    z = (lo | (hi << 8)).reshape(G, G)
    r = (z >> 1) ^ -(z & 1)
    q = np.zeros((G, G), np.int64)
    for j in range(G):
        for i in range(G):
            if i == 0 and j == 0:
                p = 0
            elif j == 0:
                p = q[0, i - 1]
            elif i == 0:
                p = q[j - 1, 0]
            else:
                p = q[j, i - 1] + q[j - 1, i] - q[j - 1, i - 1]
            q[j, i] = (p + r[j, i]) & 0xFFFF
    return meta, (meta["base"] + q * meta["step"]).astype(np.float32)


def tile_wanted(sources, cfg: dict, level: int, face: int, x: int, y: int) -> bool:
    if level == 0:
        return True
    if level > cfg["max_level"]:
        return False
    cell = tile_cell_size(level, face, x, y)
    lat, _ = dirs_to_latlon(tile_probe(level, face, x, y))
    for s in sources:
        if s.res_m > cfg["refine_factor"] * cell:
            continue
        if level > getattr(s, "max_level", 99):
            continue
        if (s.weight(lat) > 0).any():
            return True
    return False


def child_mask(sources, cfg, level, face, x, y) -> int:
    m = 0
    for cy in range(2):
        for cx in range(2):
            if tile_wanted(sources, cfg, level + 1, face, 2 * x + cx, 2 * y + cy):
                m |= 1 << ((cy << 1) | cx)
    return m
