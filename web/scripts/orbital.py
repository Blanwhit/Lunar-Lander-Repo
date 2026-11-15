"""Index, upload and verify the orbital tile pyramid without a second on-disk copy."""
import argparse
import base64
import collections
import concurrent.futures
import getpass
import hashlib
import json
from pathlib import Path
import struct
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / 'worker' / 'orbital-catalog.json'
SIDE = 16


def layout(tiles):
    groups = collections.defaultdict(dict)
    for kind, suffix in [('h', '.bin'), ('c', '.ktx2')]:
        for path in (tiles / kind).rglob('*' + suffix):
            level, face, y, _ = path.relative_to(tiles / kind).parts
            x, y = int(path.stem), int(y)
            group = f'{kind}/{level}/{face}/{y // SIDE}/{x // SIDE}'
            groups[group][(y % SIDE) * SIDE + x % SIDE] = path
    return groups


def index(groups, tiles):
    packs = {}
    for group, files in sorted(groups.items()):
        digest = hashlib.sha256()
        offsets = [0]
        for i in range(SIDE * SIDE):
            size = 0
            if i in files:
                data = files[i].read_bytes()
                digest.update(data)
                size = len(data)
            offsets.append(offsets[-1] + size)
        table = base64.b64encode(struct.pack('<257I', *offsets)).decode()
        packs[group] = dict(sha=digest.hexdigest(), size=offsets[-1], offsets=table)
    meta = json.loads((tiles / 'meta.json').read_text())
    version = hashlib.sha256(json.dumps(packs, sort_keys=True).encode()).hexdigest()
    return dict(id=version, maxLevel=meta['maxLevel'], colourMaxLevel=meta['colourMaxLevel'], packs=packs)


def upload(groups, catalog, site):
    import requests
    token = getpass.getpass('Private moon Site access (hidden): ')
    local = threading.local()

    def request(method, path, **kwargs):
        if not hasattr(local, 'http'):
            local.http = requests.Session()
            local.http.headers['OAI-Sites-Authorization'] = 'Bearer ' + token
        for attempt in range(6):
            try:
                response = local.http.request(method, site + path, allow_redirects=False, timeout=(20, 180), **kwargs)
                if response.status_code in (429, 408) or response.status_code >= 500:
                    raise requests.RequestException(str(response.status_code) + ' ' + response.text[:150])
                if not 200 <= response.status_code < 300:
                    raise RuntimeError(f'{method} {path} returned {response.status_code}: {response.text[:200]}')
                return response
            except requests.RequestException:
                if attempt == 5:
                    raise
                time.sleep(2 ** attempt)

    def push(item):
        group, entry = item
        files = groups[group]
        data = b''.join(files[i].read_bytes() for i in sorted(files))
        assert hashlib.sha256(data).hexdigest() == entry['sha']
        request('PUT', '/__orbital/packs/' + entry['sha'], data=data, headers={'Content-Type':'application/octet-stream'})
        return len(data)

    entries = catalog['packs']
    existing = set(request('GET', '/__orbital/inventory').json()['packs'])
    todo = [(k, v) for k, v in entries.items() if v['sha'] not in existing]
    print(f'{len(entries)-len(todo)} packs already verified, {len(todo)} to upload', flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
        futures = [pool.submit(push, item) for item in todo]
        total = 0
        for n, f in enumerate(concurrent.futures.as_completed(futures), 1):
            total += f.result()
            if n % 20 == 0 or n == len(todo):
                print(f'{n}/{len(todo)} packs uploaded, {total/1e9:.2f} GB', flush=True)
    assert set(request('GET', '/__orbital/inventory').json()['packs']) >= {v['sha'] for v in entries.values()}
    # Fetch an actual binary from every level of both pyramids, including sparse polar branches.
    examples = {}
    for group, files in sorted(groups.items()):
        kind, level, *_ = group.split('/')
        examples[kind,level] = next(iter(files.values()))
    for tile in examples.values():
        rel = '/'.join(tile.parts[-5:])
        assert request('GET', '/orbital/' + rel).content == tile.read_bytes(), rel
    result = request('POST', '/__orbital/activate').json()
    assert result['id'] == catalog['id']
    status = request('GET', '/orbital/status.json').json()
    assert status['maxLevel'] == catalog['maxLevel'] and status['colourMaxLevel'] == catalog['colourMaxLevel']
    print('Verified',len(entries),'packs and byte-matched',len(examples),'hosted tile levels. Active:',status,flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['index','upload'])
    parser.add_argument('tiles', type=Path)
    parser.add_argument('--site')
    args = parser.parse_args()
    groups = layout(args.tiles)
    if args.operation == 'index':
        catalog = index(groups,args.tiles)
        CATALOG.write_text(json.dumps(catalog,separators=(',',':'))+'\n')
        print(len(catalog['packs']),'packs,',sum(map(len,groups.values())),'tiles')
    else:
        from urllib.parse import urlsplit
        u = urlsplit(args.site or '')
        if u.scheme != 'https' or not u.hostname or not u.hostname.endswith('.chatgpt.site') or u.netloc!=u.hostname or u.path or u.query or u.fragment:
            parser.error('Use the private Site HTTPS origin for --site')
        upload(groups,json.loads(CATALOG.read_text()),args.site)
