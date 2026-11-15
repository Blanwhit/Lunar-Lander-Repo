"""Package the native Aussel (2025) LROC boulder densities and diameter curve.

Run this script with NumPy, Requests and tifffile installed. Source rasters
are in detections per square kilometre, already normalized by the survey.
Never infer no-data from the count; both NaN and zero occur in the source.
"""
import csv
import hashlib
import json
from pathlib import Path
import zlib

import numpy as np
import requests
import tifffile


ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / 'data/rock-research'
OUT = ROOT / 'web/public/lunar-rocks'
RECORD = 'https://zenodo.org/records/15520275'
FILES = {
    'boulder_density_4p5_10m.tif': 'fd697a142d5f31c20dd6279297050fce',
    'boulder_density_10_30m.tif': 'a926b174450285432854c8a9741bd39a',
    'boulder_density_30_1000m.tif': 'bb2812420d2bd95fa0ce1a3949b98282',
    'global_boulder_diameter_distr_cumulative.csv': '1f42682034a3471d662a96d19c3a4b43',
}
WIDTH, HEIGHT, LOG_SCALE, NODATA = 2880, 960, 4096, 65535


def source(name):
    path = RAW / name
    if not path.exists():
        temporary = path.with_suffix('.part')
        with requests.get(f'{RECORD}/files/{name}?download=1', stream=True, timeout=90) as response:
            response.raise_for_status()
            with temporary.open('wb') as f:
                for block in response.iter_content(1024 * 1024):
                    f.write(block)
        if hashlib.md5(temporary.read_bytes()).hexdigest() != FILES[name]:
            raise ValueError(f'Download checksum mismatch: {name}')
        temporary.replace(path)
    if hashlib.md5(path.read_bytes()).hexdigest() != FILES[name]:
        raise ValueError(f'Source checksum mismatch: {name}')
    return path


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    counts = np.full((HEIGHT, WIDTH, 3), NODATA, dtype='<u2')
    valid = None
    for band, name in enumerate(name for name in FILES if name.endswith('.tif')):
        with tifffile.TiffFile(source(name)) as raster:
            geo = raster.geotiff_metadata
            assert geo['ModelTiepoint'] == [0, 0, 0, -180, 60, 0]
            assert geo['ModelPixelScale'] == [.125, .125, 0]
            assert geo['GTRasterTypeGeoKey'] == 1  # grid cells are pixel areas
            values = raster.asarray()
        assert values.shape == (HEIGHT, WIDTH)
        measured = np.isfinite(values)
        if valid is not None:
            assert np.array_equal(measured, valid)
        valid = measured
        assert values[valid].min() == 0
        quantized = np.rint(LOG_SCALE * np.log1p(values[valid]))
        assert quantized.max() < NODATA
        counts[:, :, band][valid] = quantized.astype('<u2')

    with source('global_boulder_diameter_distr_cumulative.csv').open() as f:
        rows = csv.DictReader(f)
        curve = [[float(r['Boulder diameter (m)']), float(r['Global boulder density per km^2'])] for r in rows]
    assert all(a[0] < b[0] and a[1] > b[1] for a, b in zip(curve, curve[1:]))
    assert curve[0][0] == 4.5 and curve[-1][1] == 0

    (OUT / 'boulder-counts.u16.z').write_bytes(zlib.compress(counts.tobytes(), 9))
    metadata = dict(
        attribution='Ben Aussel (2025), CC BY 4.0', license='https://creativecommons.org/licenses/by/4.0/',
        source=RECORD, paper='https://doi.org/10.1029/2025JE008981',
        width=WIDTH, height=HEIGHT, west=-180, north=60, pixelsPerDegree=8,
        logScale=LOG_SCALE, noData=NODATA, bandsMetres=[4.5, 10, 30],
        diameterCumulative=curve, units='detections per square kilometre',
        encoding='row-major, pixel-interleaved, little-endian uint16, zlib; density = expm1(code / logScale)',
    )
    (OUT / 'boulder-counts.json').write_text(json.dumps(metadata, indent=2) + '\n')
    print(f'{valid.sum():,} measured cells, {(~valid).sum():,} missing; three size ranges')


if __name__ == '__main__':
    main()
