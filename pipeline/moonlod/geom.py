"""Cube-sphere geometry shared by the pipeline and (mirrored in TypeScript) the viewer.

Conventions -- keep in sync with web/src/geom.ts
------------------------------------------------
* Body frame: lunar Mean-Earth/Polar-Axis (ME/PA). +X -> (lat 0, lon 0), +Z -> north
  pole, +Y -> (lat 0, lon 90E). Longitudes are east-positive in [0, 360).
* Six cube faces, each with outward normal N and in-plane axes U, V (U x V = N).
* Equi-angular cube map (EAC): face coordinate a, b in [-1, 1] maps to the cube point
      c = N + tan(pi/4 * a) * U + tan(pi/4 * b) * V,  dir = c / |c|
* Quadtree: level L has 2^L x 2^L tiles per face; tile (x, y) covers
      a in [-1 + 2x/n, -1 + 2(x+1)/n],  b in [-1 + 2y/n, -1 + 2(y+1)/n],  n = 2^L
* Height tiles: TILE_N = 256 cells -> 257 vertices; stored with a 1-sample border
  => GRID = 259 samples per side; sample index k in [0, 259) is vertex i = k - 1,
  a = a0 + i / 256 * (a1 - a0).
* Colour tiles: 256 x 256 corner-aligned (edge texels lie on the tile boundary and are
  shared with the neighbour -> seamless bilinear): a = a0 + k / 255 * (a1 - a0).
"""
from __future__ import annotations

import numpy as np

R_MOON = 1737400.0  # m, reference sphere of all LOLA/SLDEM products
TILE_N = 256
GRID = TILE_N + 3  # 259 samples: 257 vertices + 1 border each side
COLOUR_N = 256

# face: (N, U, V)
FACES = np.array(
    [
        [[1, 0, 0], [0, 1, 0], [0, 0, 1]],  # 0 +X
        [[-1, 0, 0], [0, -1, 0], [0, 0, 1]],  # 1 -X
        [[0, 1, 0], [-1, 0, 0], [0, 0, 1]],  # 2 +Y
        [[0, -1, 0], [1, 0, 0], [0, 0, 1]],  # 3 -Y
        [[0, 0, 1], [0, 1, 0], [-1, 0, 0]],  # 4 +Z
        [[0, 0, -1], [0, 1, 0], [1, 0, 0]],  # 5 -Z
    ],
    dtype=np.float64,
)
for _f in FACES:
    assert np.allclose(np.cross(_f[1], _f[2]), _f[0])


def tile_bounds(level: int, x: int, y: int) -> tuple[float, float, float, float]:
    n = 1 << level
    a0 = -1.0 + 2.0 * x / n
    b0 = -1.0 + 2.0 * y / n
    return a0, a0 + 2.0 / n, b0, b0 + 2.0 / n


def face_dirs(face: int, a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Unit direction vectors (..., 3) for face coordinates a, b (any matching shape)."""
    N, U, V = FACES[face]
    s = np.tan(np.pi / 4 * a)[..., None]
    t = np.tan(np.pi / 4 * b)[..., None]
    c = N + s * U + t * V
    return c / np.linalg.norm(c, axis=-1, keepdims=True)


def dirs_to_latlon(d: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """-> (lat_deg, lon_deg_east in [0, 360))."""
    lat = np.degrees(np.arcsin(np.clip(d[..., 2], -1, 1)))
    lon = np.degrees(np.arctan2(d[..., 1], d[..., 0])) % 360.0
    return lat, lon


def latlon_to_dir(lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    la, lo = np.radians(lat), np.radians(lon)
    return np.stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)], axis=-1)


def dir_to_face(d: np.ndarray) -> tuple[int, float, float]:
    """Single direction -> (face, a, b)."""
    best = int(np.argmax([np.dot(d, f[0]) for f in FACES]))
    N, U, V = FACES[best]
    c = d / np.dot(d, N)
    s, t = np.dot(c, U), np.dot(c, V)
    return best, float(np.arctan(s) * 4 / np.pi), float(np.arctan(t) * 4 / np.pi)


def height_ab(level: int, x: int, y: int) -> tuple[np.ndarray, np.ndarray]:
    a0, a1, b0, b1 = tile_bounds(level, x, y)
    i = np.arange(-1, TILE_N + 2, dtype=np.float64)
    a = a0 + i / TILE_N * (a1 - a0)
    b = b0 + i / TILE_N * (b1 - b0)
    return np.meshgrid(a, b)


def height_grid(level: int, face: int, x: int, y: int) -> np.ndarray:
    """(GRID, GRID, 3) directions of the height samples (row = b index, col = a index)."""
    A, B = height_ab(level, x, y)
    return face_dirs(face, A, B)


def colour_ab(level: int, x: int, y: int, n: int = COLOUR_N) -> tuple[np.ndarray, np.ndarray]:
    a0, a1, b0, b1 = tile_bounds(level, x, y)
    k = np.arange(n, dtype=np.float64) / (n - 1)
    return np.meshgrid(a0 + k * (a1 - a0), b0 + k * (b1 - b0))


def colour_grid(level: int, face: int, x: int, y: int, n: int = COLOUR_N) -> np.ndarray:
    A, B = colour_ab(level, x, y, n)
    return face_dirs(face, A, B)


def local_cell(level: int, a: np.ndarray, b: np.ndarray, n: int = TILE_N) -> np.ndarray:
    """Analytic ground footprint (m) of one sample at face coords (a, b) on a grid with
    n samples per tile side at `level`: max of the EAC arc lengths along a and b.
    Depends only on (level, a, b), so samples shared by adjacent tiles get identical
    values -> identical mip selection -> seamless tile edges."""
    s = np.tan(np.pi / 4 * a)
    t = np.tan(np.pi / 4 * b)
    c2 = 1 + s * s + t * t
    da = np.pi / 4 * (1 + s * s) * np.sqrt(1 + t * t) / c2
    db = np.pi / 4 * (1 + t * t) * np.sqrt(1 + s * s) / c2
    step = 2.0 / (1 << level) / n
    return R_MOON * step * np.maximum(da, db)


def tile_cell_size(level: int, face: int, x: int, y: int) -> float:
    """Mean ground distance (m) between adjacent height samples of the tile."""
    a0, a1, b0, b1 = tile_bounds(level, x, y)
    am, bm = (a0 + a1) / 2, (b0 + b1) / 2
    d = face_dirs(face, np.array([a0, a1, am, am]), np.array([bm, bm, b0, b1]))
    w = np.arccos(np.clip(np.dot(d[0], d[1]), -1, 1))
    h = np.arccos(np.clip(np.dot(d[2], d[3]), -1, 1))
    return float(R_MOON * (w + h) / 2 / TILE_N)


def tile_probe(level: int, face: int, x: int, y: int, n: int = 9) -> np.ndarray:
    """Coarse n x n grid of directions over the tile (incl. edges) for coverage tests."""
    a0, a1, b0, b1 = tile_bounds(level, x, y)
    A, B = np.meshgrid(np.linspace(a0, a1, n), np.linspace(b0, b1, n))
    return face_dirs(face, A, B)
