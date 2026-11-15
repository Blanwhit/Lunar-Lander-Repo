"""Build the walking atlas from the numeric PDS Diviner GDR V6 rock abundance mosaic.

Download the JP2 from BASE to data/rock-research, then run this script with NumPy
and the OpenJPEG opj_decompress executable installed. Uses stripes of native DNs
because reduced-resolution JPEG2000 decoding mixes no-data into valid pixels.
"""
from pathlib import Path
from tempfile import TemporaryDirectory
import hashlib
import subprocess
import zlib

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
BASE = ('https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/'
        'data_derived_gdr_l3/cylindrical/jp2/')
PRODUCT = 'dgdr_ra_avg_cyl_128_jp2.jp2'
DIGEST = 'a18898ee8b71a58090720fe8d852919c269bb9eedfa8e0299a757ecebda67da8'
SOURCE = ROOT / 'data' / 'rock-research' / PRODUCT
OUT = ROOT / 'web' / 'public' / 'lunar-rocks'
NATIVE_PPD = 128
OUTPUT_PPD = 8
REDUCTION = NATIVE_PPD // OUTPUT_PPD
NODATA = 65535


def encode(dn, valid):
    """PDS DNs represent a fraction in steps of 0.001. Keep zero distinct from no-data."""
    encoded = np.full(dn.shape, NODATA, dtype='<u2')
    encoded[valid] = np.rint(dn[valid] * (0.001 * 65534)).astype('<u2')
    return encoded


def read_window(raw_path, left, top, width, height):
    subprocess.run([
        'opj_decompress', '-quiet', '-threads', '4', '-i', str(SOURCE), '-o', str(raw_path),
        '-d', f'{left},{top},{left + width},{top + height}',
    ], check=True, stdout=subprocess.DEVNULL)
    return np.fromfile(raw_path, dtype='<i2').reshape(height, width)


def save(name, grid):
    path = OUT / (name + '.bin.z')
    # A zlib-wrapped DEFLATE stream, row-major Uint16 little endian.
    path.write_bytes(zlib.compress(grid.tobytes(), level=9))
    print(f'{path.name}: {grid.shape}, {np.count_nonzero(grid != NODATA)} valid cells, '
          f'{path.stat().st_size:,} bytes', flush=True)


def main():
    if not SOURCE.exists():
        raise SystemExit(f'Download {BASE}{PRODUCT} to {SOURCE}')
    with SOURCE.open('rb') as f:
        if hashlib.file_digest(f, 'sha256').hexdigest() != DIGEST:
            raise ValueError('Unexpected or incomplete PDS product')
    OUT.mkdir(parents=True, exist_ok=True)
    width = 360 * NATIVE_PPD
    height = 160 * NATIVE_PPD
    atlas = np.empty((height // REDUCTION, width // REDUCTION), dtype='<u2')
    with TemporaryDirectory(dir=SOURCE.parent) as scratch:
        raw_path = Path(scratch) / 'window.rawl'
        for top in range(0, height, 512):
            # The JP2's western edge is -180 E; the separately archived IMG starts at 0 E.
            data = read_window(raw_path, 0, top, width, 512)
            blocks = data.reshape(512 // REDUCTION, REDUCTION, width // REDUCTION, REDUCTION)
            valid = (blocks >= 0) & (blocks <= 1000)
            count = np.sum(valid, axis=(1, 3))
            totals = np.sum(blocks, where=valid, axis=(1, 3), dtype=np.int64)
            # Require at least 1/8 of the 256 native samples for a regional estimate.
            regional = encode(totals / np.maximum(count, 1), count >= REDUCTION**2 // 8)
            atlas[top // REDUCTION:(top + 512) // REDUCTION] = np.roll(regional, regional.shape[1] // 2, axis=1)
        save('abundance', atlas)
        # Latitude-strip areas on a sphere are proportional to differences in sin(latitude).
        lat_edges = np.radians(80 - np.arange(atlas.shape[0] + 1) / OUTPUT_PPD)
        weights = -np.diff(np.sin(lat_edges))
        measured = atlas != NODATA
        valid_area = np.dot(weights, np.sum(measured, axis=1))
        coverage = valid_area / (2 * atlas.shape[1])
        mean = np.dot(weights, np.sum(atlas, where=measured, axis=1)) / (valid_area * 65534)
        print(f'Mapped area fraction of Moon: {coverage:.8f}; mean mapped rock cover: {mean:.8f}')
        for name, north, west in [('apollo17', 21, 30), ('tycho', -42, -12)]:
            native = read_window(raw_path, (west + 180) * NATIVE_PPD,
                                 (80 - north) * NATIVE_PPD, 2 * NATIVE_PPD, 2 * NATIVE_PPD)
            save('abundance-' + name, encode(native, (native >= 0) & (native <= 1000)))


if __name__ == '__main__':
    main()
