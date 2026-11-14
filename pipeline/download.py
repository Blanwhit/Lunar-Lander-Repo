"""Resumable, multi-connection, multi-mirror downloader for the raw source data.

Usage:  python pipeline/download.py [--groups lola_global,sldem,...] [--out data/raw]

* Every file is split into fixed-size chunks fetched with HTTP Range requests by a
  thread pool; chunks are spread round-robin over all mirrors listed for the file.
* Progress is tracked in <file>.parts.json so an interrupted run resumes.
* Before anything is fetched, the size of every file is printed. Files larger than
  --max-gb (default 5 GB) are refused unless --allow-large is passed.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests

CHUNK = 32 * 1024 * 1024
ROOT = Path(__file__).resolve().parent.parent
UA = {"User-Agent": "moon-lod-pipeline/1.0 (python-requests)"}


def head_size(url: str) -> int | None:
    try:
        r = requests.head(url, allow_redirects=True, timeout=30, headers=UA)
        if r.status_code == 200 and "content-length" in r.headers:
            return int(r.headers["content-length"])
        # some servers do not answer HEAD properly; try a 1-byte range
        r = requests.get(url, headers={**UA, "Range": "bytes=0-0"}, timeout=30, stream=True)
        cr = r.headers.get("content-range", "")
        r.close()
        if "/" in cr:
            return int(cr.split("/")[-1])
    except requests.RequestException:
        pass
    return None


def fetch_chunk(urls: list[str], idx: int, start: int, end: int, path: Path, lock: threading.Lock) -> int:
    last_err = None
    for attempt in range(8):
        url = urls[(idx + attempt) % len(urls)]
        try:
            r = requests.get(url, headers={**UA, "Range": f"bytes={start}-{end}"}, timeout=60, stream=True)
            if r.status_code not in (200, 206):
                raise IOError(f"HTTP {r.status_code} for {url}")
            if r.status_code == 200 and start != 0:
                raise IOError(f"server ignored Range for {url}")
            buf = bytearray()
            for block in r.iter_content(1 << 20):
                buf += block
                if len(buf) > end - start + 1:
                    break
            buf = buf[: end - start + 1]
            if len(buf) != end - start + 1:
                raise IOError(f"short read {len(buf)} != {end - start + 1}")
            with lock:
                with open(path, "r+b") as f:
                    f.seek(start)
                    f.write(buf)
            return len(buf)
        except Exception as e:  # noqa: BLE001 - retry anything
            last_err = e
            time.sleep(min(30, 2 ** attempt))
    raise RuntimeError(f"chunk {idx} of {path.name} failed: {last_err}")


def download(entry: dict, out: Path, pool: ThreadPoolExecutor, size: int) -> list:
    path = out / entry["name"]
    state_path = path.with_name(path.name + ".parts.json")
    if path.exists() and not state_path.exists() and path.stat().st_size == size:
        return []
    nchunks = (size + CHUNK - 1) // CHUNK
    done: set[int] = set()
    if state_path.exists():
        done = set(json.loads(state_path.read_text())["done"])
    if not path.exists() or path.stat().st_size != size:
        done = set()
        # write the resume state *before* allocating so a preallocated file is never
        # mistaken for a complete one
        state_path.write_text(json.dumps({"done": []}))
        with open(path, "wb") as f:
            f.truncate(size)
    lock = threading.Lock()
    tasks = []
    for i in range(nchunks):
        if i in done:
            continue
        s, e = i * CHUNK, min(size, (i + 1) * CHUNK) - 1
        meta = (entry["name"], i, state_path, done, nchunks)
        tasks.append((fetch_chunk, (entry["urls"], i, s, e, path, lock), meta))
    return tasks


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--groups", default="all")
    ap.add_argument("--out", default=str(ROOT / "data" / "raw"))
    ap.add_argument("--workers", type=int, default=10)
    ap.add_argument("--max-gb", type=float, default=5.0)
    ap.add_argument("--allow-large", action="store_true")
    ap.add_argument("--list", action="store_true", help="only print sizes")
    args = ap.parse_args()

    manifest = json.loads((Path(__file__).parent / "sources.json").read_text())["files"]
    groups = None if args.groups == "all" else set(args.groups.split(","))
    entries = [e for e in manifest if groups is None or e["group"] in groups]
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    sizes = {}
    total = 0
    print(f"{'file':48s} {'size':>12s}")
    for e in entries:
        sz = None
        for u in e["urls"]:
            sz = head_size(u)
            if sz:
                break
        if sz is None:
            sys.exit(f"cannot determine size of {e['name']}")
        sizes[e["name"]] = sz
        total += sz
        flag = "  <-- exceeds limit" if sz > args.max_gb * 1e9 else ""
        print(f"{e['name']:48s} {sz / 1e6:10.1f} MB{flag}")
    print(f"{'TOTAL':48s} {total / 1e9:10.2f} GB")
    big = [n for n, s in sizes.items() if s > args.max_gb * 1e9]
    if big and not args.allow_large:
        sys.exit(f"refusing to download files > {args.max_gb} GB without --allow-large: {big}")
    if args.list:
        return

    t0 = time.time()
    got = 0
    with ThreadPoolExecutor(args.workers) as pool:
        # interleave chunks round-robin across files (small files first) so that every
        # mirror/server is busy at the same time instead of one file after another
        queues = [download(e, out, pool, sizes[e["name"]])
                  for e in sorted(entries, key=lambda e: sizes[e["name"]])]
        order = []
        while any(queues):
            for q in queues:
                if q:
                    order.append(q.pop(0))
        futs = []
        for fn, fargs, meta in order:
            fut = pool.submit(fn, *fargs)
            fut.meta = meta  # type: ignore[attr-defined]
            futs.append(fut)
        print(f"{len(futs)} chunks to fetch")
        for fut in as_completed(futs):
            name, i, state_path, done, nchunks = fut.meta  # type: ignore[attr-defined]
            got += fut.result()
            done.add(i)
            if len(done) == nchunks:
                state_path.unlink(missing_ok=True)
                print(f"  done {name}", flush=True)
            else:
                state_path.write_text(json.dumps({"done": sorted(done)}))
            el = time.time() - t0
            print(f"  {got / 1e6:9.0f} MB  {got / 1e6 / el:6.2f} MB/s  {name}#{i}", flush=True)
    print(f"finished in {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
