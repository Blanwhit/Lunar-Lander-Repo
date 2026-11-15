"""Height-tile construction and encoding.

File format (`tiles/h/{L}/{face}/{y}/{x}.bin`), little-endian:

    off  type      field
    0    char[4]   magic "MLH2"
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
    36   ...       G x G unsigned 16-bit q, row-major, as a moonlod.gridcodec block
                   (lossless; decoded in the browser by web/src/terrain/gridCodec.ts)

All heights are metres relative to the 1737.4 km sphere.
"""
from __future__ import annotations

import struct

import numpy as np

from .gridcodec import decode_grid, encode_grid
from .geom import dirs_to_latlon, face_dirs, height_ab, local_cell, tile_cell_size, tile_probe

MAGIC = b"MLH2"
HEADER = struct.Struct("<4sBBBBIIffffHH")


def composite_heights(sources, lat, lon, cell_m) -> np.ndarray:
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
    A, B = height_ab(level, x, y)
    lat, lon = dirs_to_latlon(face_dirs(face, A, B))
    cell = local_cell(level, A, B)  # per-sample footprint -> seamless mip selection
    return composite_heights(sources, lat, lon, cell)


def step_for_level(cell_m: float) -> float:
    """Height quantum ~ cell/256 (power of two): constant ~0.2 deg slope precision at
    every level -> coarse levels (initial load) compress much better, fine levels keep
    cm precision. Clamped to [1/32 m, 32 m]."""
    s = 2.0 ** np.round(np.log2(cell_m / 256.0))
    return float(np.clip(s, 1.0 / 32.0, 32.0))


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
    hdr = HEADER.pack(MAGIC, level, face, child_mask, 0, x, y, hmin, hmax, step, base, G, 0)
    return hdr + encode_grid(q)


def decode_q(blob: bytes) -> tuple[dict, np.ndarray]:
    """header fields and the quantised grid q (uint16); heights are base + q * step"""
    f = HEADER.unpack_from(blob, 0)
    meta = dict(zip(["magic", "level", "face", "child_mask", "flags", "x", "y", "hmin", "hmax", "step", "base", "G", "_"], f))
    if meta["magic"] != MAGIC:
        raise ValueError(f"not an {MAGIC.decode()} tile")
    G = meta["G"]
    q = decode_grid(memoryview(blob)[HEADER.size:], G, G, signed=False)
    return meta, q.astype(np.uint16)


def decode(blob: bytes) -> tuple[dict, np.ndarray]:
    meta, q = decode_q(blob)
    return meta, (meta["base"] + q.astype(np.float64) * meta["step"]).astype(np.float32)


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
    """All-or-nothing: if any child adds detail, all four are generated, so the viewer
    can always replace a parent by its complete set of children."""
    for cy in range(2):
        for cx in range(2):
            if tile_wanted(sources, cfg, level + 1, face, 2 * x + cx, 2 * y + cy):
                return 0b1111
    return 0
