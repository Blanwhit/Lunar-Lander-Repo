"""Bake tileable, synthetic crater relief for the surface walk (RG slopes, B reflectance)."""
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

SIZE = 1024
rng = np.random.default_rng(1717)


def noise(cells):
    """Smooth periodic noise. Padding keeps opposite edges continuous."""
    samples = rng.normal(size=(cells, cells)).astype(np.float32)
    edge = 2 * SIZE // cells
    padded = np.pad(samples, 2, mode="wrap")
    image = cv2.resize(padded, (SIZE + 2 * edge,) * 2, interpolation=cv2.INTER_CUBIC)
    return image[edge:-edge, edge:-edge]


def build():
    rough = noise(8) * 1.15 + noise(32) * 0.55 + noise(128) * 0.16
    height = rough.copy()
    tone = 0.032 * noise(8) + 0.028 * noise(32) + 0.024 * noise(128)
    warp = noise(64) + noise(256) * 0.35
    # Overlapping bowls, weathered rims and broken ejecta give low light a surface to rake.
    for count, lo, hi in [(12, 34, 78), (95, 12, 31), (670, 3, 12), (1400, 1.3, 4.5)]:
        for _ in range(count):
            radius = rng.uniform(lo, hi)
            reach = int(np.ceil(radius * 1.75))
            yy, xx = np.mgrid[-reach:reach+1, -reach:reach+1]
            ix = (xx + rng.integers(SIZE)) % SIZE
            iy = (yy + rng.integers(SIZE)) % SIZE
            phase = rng.uniform(0, 2*np.pi)
            r = np.hypot(xx, yy*rng.uniform(0.90, 1.1)) / radius
            r *= 1 + 0.042*np.sin(3*np.arctan2(yy, xx)+phase) + 0.029*warp[iy, ix]
            freshness = rng.uniform(0.4, 1.0)
            bowl = np.maximum(1-r*r, 0)**2
            rim = np.exp(-((r-1)/0.21)**2)
            blanket = np.maximum(1-np.abs(r-1)/0.65, 0)**2
            height[iy, ix] += radius*freshness*(0.08*rim - 0.28*bowl + 0.022*blanket*warp[iy, ix])
            tone[iy, ix] += freshness*(0.10*blanket - 0.045*bowl)
    dx = (np.roll(height, -1, axis=1)-np.roll(height, 1, axis=1))/2
    dy = (np.roll(height, -1, axis=0)-np.roll(height, 1, axis=0))/2
    # TextureLoader flips the rows on upload, reversing the sign of the V derivative.
    packed = np.stack([-dx, dy, tone], axis=2)
    rgb = np.round(128 + np.clip(packed, -1, 1)*127).astype(np.uint8)
    path = Path(__file__).resolve().parents[1] / "web/public/lunar-soil/crater-relief.png"
    Image.fromarray(rgb).save(path, optimize=True)


if __name__ == "__main__":
    build()
