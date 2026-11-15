"""Tile the native LOLA global raster for self-contained, arbitrary surface landings.

The cylindrical PDS product is pixel-registered at 64 pixels per degree. Make
shared vertices at 32 per degree; the antimeridian wraps and each pole has a
single value. Heights use metres relative to the 1,737.4 km LOLA sphere.
"""
import numpy as np

from export_walk_terrain import ROOT, OUT, patch, write_grid
import json


def main():
    raw = np.memmap(ROOT / 'data/raw/LDEM_64.IMG', dtype='<i2', mode='r', shape=(11520, 23040))
    out = OUT / 'regions'
    out.mkdir(parents=True, exist_ok=True)
    ppd = 32
    cells = 15 * ppd
    tiles = []
    for y in range(12):
        rows = (y*cells + np.arange(cells + 1))*2
        north, south = (rows-1).clip(0,11519), rows.clip(0,11519)
        for x in range(24):
            cols = (x*cells + np.arange(cells + 1))*2
            west, east = (cols-1)%23040, cols%23040
            h = sum(raw[np.ix_(j,i)].astype(np.float32) for j in (north,south) for i in (west,east)) * .125
            if y == 0:
                h[0] = raw[0].mean()*.5
            if y == 11:
                h[-1] = raw[-1].mean()*.5
            tiles.append(write_grid(f'regions/{y}-{x}.bin', h, 8, offset=0))
    polar = [patch(name, lat, 0, 1025, 160, 7) for name, lat in [('north-cap',90),('south-cap',-90)]]
    manifest = {"degrees":15,"width":cells+1,"step":8,"offset":0,"polar":polar}
    (out/'index.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print(f'Exported {len(tiles)} regional tiles, {sum(f.stat().st_size for f in out.iterdir())/1e6:.1f} MB')


if __name__ == '__main__':
    main()
