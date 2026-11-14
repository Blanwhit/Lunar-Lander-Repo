"""Lossless, verified packing of the raw source data (data/raw -> data/raw_packed).

    python -I pipeline/pack_raw.py pack     # compress, verify by SHA-256 round trip, remove originals
    python -I pipeline/pack_raw.py unpack   # restore the exact original files into data/raw
    python -I pipeline/pack_raw.py verify   # re-check every packed file against its recorded hash

Raster files are filtered before zstd so they compress ~2x better than plain zstd:
  * int16 PDS IMG  : sample-wise delta (mod 2^16) + byte shuffle
  * float32 IMG    : XOR with the previous sample's bits + byte shuffle
  * anything else  : stored as plain zstd
Filters work on independent 64 MiB chunks, so packing and unpacking stream with bounded
memory. Every file's SHA-256 is stored in manifest.json and checked after packing (by a
full decompression) and again on unpack; an original is deleted only after its packed copy
has been verified bit-exact.
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import zstandard

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
PACKED = ROOT / "data" / "raw_packed"
MANIFEST = PACKED / "manifest.json"
CHUNK = 64 * 2 ** 20  # multiple of 4
LEVEL = 15


def kind_of(name: str) -> str:
    u = name.upper()
    if u.endswith(".IMG"):
        return "f32" if "FLOAT" in u else "i16"
    return "raw"


def _filter(buf: bytes, kind: str) -> bytes:
    if kind == "raw" or len(buf) % 4 or not buf:
        return buf
    if kind == "i16":
        a = np.frombuffer(buf, "<u2")
        d = np.empty_like(a)
        d[0] = a[0]
        d[1:] = a[1:] - a[:-1]  # uint16 arithmetic wraps: exact inverse is cumsum mod 2^16
        w = 2
    else:
        a = np.frombuffer(buf, "<u4")
        d = np.empty_like(a)
        d[0] = a[0]
        d[1:] = a[1:] ^ a[:-1]
        w = 4
    return d.view(np.uint8).reshape(-1, w).T.tobytes()


def _unfilter(buf: bytes, kind: str) -> bytes:
    if kind == "raw" or len(buf) % 4 or not buf:
        return buf
    w = 2 if kind == "i16" else 4
    d = np.frombuffer(buf, np.uint8).reshape(w, -1).T.copy().view("<u2" if w == 2 else "<u4").ravel()
    if kind == "i16":
        a = np.cumsum(d, dtype=np.uint16)  # wraps mod 2^16
    else:
        a = np.bitwise_xor.accumulate(d)
    return a.tobytes()


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for blk in iter(lambda: f.read(CHUNK), b""):
            h.update(blk)
    return h.hexdigest()


def _decompressed_chunks(src: Path, kind: str):
    dctx = zstandard.ZstdDecompressor()
    with open(src, "rb") as f, dctx.stream_reader(f) as r:
        while True:
            blk = r.read(CHUNK)
            while blk and len(blk) < CHUNK:  # stream_reader may return short reads
                more = r.read(CHUNK - len(blk))
                if not more:
                    break
                blk += more
            if not blk:
                break
            yield _unfilter(blk, kind)


def pack() -> None:
    PACKED.mkdir(parents=True, exist_ok=True)
    man = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {}
    cctx = zstandard.ZstdCompressor(level=LEVEL, threads=-1)
    before = after = 0
    for p in sorted(RAW.iterdir()):
        if not p.is_file() or p.name.endswith(".parts.json"):
            continue
        if (RAW / (p.name + ".parts.json")).exists():
            print(f"skip {p.name}: incomplete download")
            continue
        kind = kind_of(p.name)
        out = PACKED / (p.name + ".zst")
        size = p.stat().st_size
        digest = sha256_file(p)
        tmp = out.with_suffix(".zst.tmp")
        with open(p, "rb") as f, open(tmp, "wb") as o, cctx.stream_writer(o, size=size) as w:
            for blk in iter(lambda: f.read(CHUNK), b""):
                w.write(_filter(blk, kind))
        # verify by full decompression before touching the original
        h = hashlib.sha256()
        n = 0
        for blk in _decompressed_chunks(tmp, kind):
            h.update(blk)
            n += len(blk)
        if n != size or h.hexdigest() != digest:
            tmp.unlink()
            sys.exit(f"VERIFY FAILED for {p.name}; original kept")
        tmp.replace(out)
        man[p.name] = {"size": size, "sha256": digest, "kind": kind, "packed": out.stat().st_size}
        MANIFEST.write_text(json.dumps(man, indent=1))
        p.unlink()
        before += size
        after += out.stat().st_size
        print(f"{p.name:44s} {size / 1e9:6.2f} GB -> {out.stat().st_size / 1e9:6.2f} GB  ({kind}, verified)", flush=True)
    if before:
        print(f"packed {before / 1e9:.2f} GB -> {after / 1e9:.2f} GB ({100 * after / before:.0f}%)")


def unpack() -> None:
    man = json.loads(MANIFEST.read_text())
    RAW.mkdir(parents=True, exist_ok=True)
    for name, m in man.items():
        dst = RAW / name
        if dst.exists() and dst.stat().st_size == m["size"]:
            continue
        h = hashlib.sha256()
        tmp = dst.with_name(dst.name + ".tmp")
        with open(tmp, "wb") as o:
            for blk in _decompressed_chunks(PACKED / (name + ".zst"), m["kind"]):
                h.update(blk)
                o.write(blk)
        if h.hexdigest() != m["sha256"]:
            tmp.unlink()
            sys.exit(f"HASH MISMATCH for {name}")
        tmp.replace(dst)
        print(f"restored {name} (sha256 ok)", flush=True)


def verify() -> None:
    man = json.loads(MANIFEST.read_text())
    bad = 0
    for name, m in man.items():
        h = hashlib.sha256()
        for blk in _decompressed_chunks(PACKED / (name + ".zst"), m["kind"]):
            h.update(blk)
        ok = h.hexdigest() == m["sha256"]
        bad += not ok
        print(f"{'ok ' if ok else 'BAD'} {name}")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    {"pack": pack, "unpack": unpack, "verify": verify}[sys.argv[1] if len(sys.argv) > 1 else "pack"]()
