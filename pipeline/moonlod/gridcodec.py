"""Lossless codec for 16-bit height grids (MLH2 height tiles and the walk-terrain grids).

Needs nothing beyond numpy here and no library in the browser (decoder:
web/src/terrain/gridCodec.ts). Three steps, each exactly invertible:

1. Lattice. Grids resampled from coarser quantised data often use only every g-th value.
   With rem = q[0,0] mod g and g = gcd(q - rem), the grid becomes (q - rem) / g.
2. Prediction, in row-major order (values are true integers; residuals wrap mod 2^16):
   * planar: pred = W + N - NW. The first row uses W, the first column uses N, q[0,0] uses 0.
   * LS: inside rows >= 2 and columns 2 .. width-3,
       pred = W + floor((sum_k c_k * (v_k - W) + 2^(FRAC-1)) / 2^FRAC)
     over the 11 causal neighbours in OFFSETS. Every other sample uses planar. The
     coefficients are a per-grid least-squares fit. Writing them on differences to W
     makes the prediction offset-invariant, so fixed-point coefficients lose nothing on
     large absolute heights.
   The encoder tries both and keeps the smaller.
3. Entropy coding. z = zigzag(residual) is split into a token (0..39: z itself below 16,
   above that the exponent plus the next bit) and raw extra bits. Tokens are coded by
   static rANS, with one frequency table per context. The context is a half-octave bucket
   of the neighbouring zigzag magnitudes 3W + 3N + NW + NE + WW + NN, which are already
   decoded. Extra bits go to a separate LSB-first bit stream.

Block layout (little-endian):
    u8   predictor (0 planar, 1 LS)        u8  number of coefficients n (0 or 11)
    i32[n] coefficients (FRAC fractional bits)
    u16  lattice divisor g (>= 1)           u16 lattice remainder rem (0 <= rem < g)
    u32  bit mask of contexts present
    per present context: u8 token count t, then t LEB128 frequencies summing to 2^PROB_BITS
    u32  rANS stream length L, then L bytes (first 4 bytes = initial state, LE)
    rest: extra bits, LSB first
"""
from __future__ import annotations

import math
import struct

import numpy as np

FRAC = 12
OFFSETS = [(-1, 0), (-1, -1), (-1, 1), (0, -2), (-2, 0), (-1, -2), (-2, -1), (-2, 1), (-1, 2), (-2, -2), (-2, 2)]
MARGIN = 2
NCTX = 20
NTOK = 40
PROB_BITS = 12
PROB = 1 << PROB_BITS
RANS_L = 1 << 23
_COEF_LIMIT = 1 << 20  # keeps every intermediate exact in float64 (the JS decoder)


# ---------------------------------------------------------------- prediction
def _planar_pred(q: np.ndarray) -> np.ndarray:
    p = np.zeros_like(q)
    p[0, 1:] = q[0, :-1]
    p[1:, 0] = q[:-1, 0]
    p[1:, 1:] = q[1:, :-1] + q[:-1, 1:] - q[:-1, :-1]
    return p


def _ls_ok(h: int, w: int) -> bool:
    return h > MARGIN + 2 and w > 2 * MARGIN + 2


def _ls_view(q: np.ndarray):
    H, W = q.shape
    m = MARGIN
    w = q[m:, m - 1:W - m - 1]
    return w, [q[m + dy:H + dy, m + dx:W - m + dx] for dy, dx in OFFSETS]


def _ls_pred(q: np.ndarray, c: np.ndarray) -> np.ndarray:
    p = _planar_pred(q)
    w, nb = _ls_view(q)
    acc = np.zeros_like(w)
    for ck, v in zip(c.tolist(), nb):
        acc += ck * (v - w)
    p[MARGIN:, MARGIN:q.shape[1] - MARGIN] = w + ((acc + (1 << (FRAC - 1))) >> FRAC)
    return p


def _fit(q: np.ndarray) -> np.ndarray:
    w, nb = _ls_view(q)
    X = np.stack([(v - w).ravel() for v in nb], 1).astype(np.float64)
    y = (q[MARGIN:, MARGIN:q.shape[1] - MARGIN] - w).ravel().astype(np.float64)
    c, *_ = np.linalg.lstsq(X, y, rcond=None)
    return np.clip(np.round(c * (1 << FRAC)), -_COEF_LIMIT, _COEF_LIMIT).astype(np.int64)


# ---------------------------------------------------------------- modelling
def _zigzag(r: np.ndarray) -> np.ndarray:
    r = ((r + 32768) & 0xFFFF) - 32768
    return ((r << 1) ^ (r >> 63)) & 0xFFFF


def _tokens(z: np.ndarray):
    big = z >= 16
    n = np.where(big, np.floor(np.log2(np.maximum(z, 1))).astype(np.int64), 0)
    tok = np.where(big, 16 + (n - 4) * 2 + ((z >> np.maximum(n - 1, 0)) & 1), z)
    nextra = np.where(big, n - 1, 0)
    extra = np.where(big, z & ((1 << nextra) - 1), 0)
    return tok, nextra, extra


def _ctx_of_sum(s: int) -> int:
    if s <= 0:
        return 0
    k = s.bit_length() - 1
    return min(NCTX - 1, 1 + 2 * k + (s * s >= 1 << (2 * k + 1)))


def _contexts(z: np.ndarray) -> np.ndarray:
    zp = np.pad(z, ((2, 0), (2, 2)))
    s = (3 * zp[2:, 1:-3] + 3 * zp[1:-1, 2:-2] + zp[1:-1, 1:-3] + zp[1:-1, 3:-1]
         + zp[2:, :-4] + zp[:-2, 2:-2])
    k = np.floor(np.log2(np.maximum(s, 1))).astype(np.int64)
    c = 1 + 2 * k + (s * s >= np.left_shift(1, 2 * k + 1))
    return np.where(s > 0, np.minimum(c, NCTX - 1), 0)


def _normalise(counts: np.ndarray) -> np.ndarray:
    """Counts -> frequencies summing to PROB, every used token >= 1."""
    total = counts.sum()
    f = np.where(counts > 0, np.maximum(1, np.floor(counts * PROB / total)), 0).astype(np.int64)
    while f.sum() != PROB:
        d = PROB - f.sum()
        if d > 0:
            f[np.argmax(counts)] += d
        else:  # take from the largest frequencies that can spare it
            i = int(np.argmax(np.where(f > 1, f, 0)))
            f[i] -= min(-d, f[i] - 1)
    return f


def _leb(v: int) -> bytes:
    out = bytearray()
    while True:
        b = v & 0x7F
        v >>= 7
        out.append(b | (0x80 if v else 0))
        if not v:
            return bytes(out)


def _entropy_encode(z: np.ndarray) -> bytes:
    tok, nextra, extra = _tokens(z.ravel())
    ctx = _contexts(z).ravel()
    tables = {}
    head = bytearray()
    mask = 0
    for c in range(NCTX):
        sel = tok[ctx == c]
        if sel.size == 0:
            continue
        mask |= 1 << c
        f = _normalise(np.bincount(sel, minlength=NTOK))
        t = int(np.nonzero(f)[0].max()) + 1
        head.append(t)
        for v in f[:t].tolist():
            head += _leb(v)
        tables[c] = (f, np.concatenate(([0], np.cumsum(f)[:-1])))
    # rANS, encoded back to front
    freq = np.zeros(tok.size, np.int64)
    start = np.zeros(tok.size, np.int64)
    for c, (f, cum) in tables.items():
        m = ctx == c
        freq[m] = f[tok[m]]
        start[m] = cum[tok[m]]
    out = bytearray()
    x = RANS_L
    xmax_k = (RANS_L >> PROB_BITS) << 8
    for fr, st in zip(freq[::-1].tolist(), start[::-1].tolist()):
        xm = xmax_k * fr
        while x >= xm:
            out.append(x & 0xFF)
            x >>= 8
        x = (x // fr << PROB_BITS) + x % fr + st
    out += bytes([(x >> 24) & 0xFF, (x >> 16) & 0xFF, (x >> 8) & 0xFF, x & 0xFF])
    out.reverse()
    # extra bits, LSB first
    nbits = int(nextra.sum())
    if nbits:
        idx = np.repeat(np.arange(nextra.size), nextra)
        pos = np.arange(nbits) - np.repeat(np.cumsum(nextra) - nextra, nextra)
        bits = ((extra[idx] >> pos) & 1).astype(np.uint8)
        xb = np.packbits(bits, bitorder="little").tobytes()
    else:
        xb = b""
    return struct.pack("<I", mask) + bytes(head) + struct.pack("<I", len(out)) + bytes(out) + xb


def _entropy_decode(buf: memoryview, pos: int, h: int, w: int) -> np.ndarray:
    (mask,) = struct.unpack_from("<I", buf, pos)
    pos += 4
    freqs, starts, lookup = {}, {}, {}
    for c in range(NCTX):
        if not mask >> c & 1:
            continue
        t = buf[pos]
        pos += 1
        f = []
        for _ in range(t):
            v = sh = 0
            while True:
                b = buf[pos]
                pos += 1
                v |= (b & 0x7F) << sh
                sh += 7
                if not b & 0x80:
                    break
            f.append(v)
        cum = [0]
        for v in f:
            cum.append(cum[-1] + v)
        freqs[c], starts[c] = f, cum
        lookup[c] = np.repeat(np.arange(t), f).tolist()
    (n,) = struct.unpack_from("<I", buf, pos)
    pos += 4
    rans = bytes(buf[pos:pos + n])
    bits = bytes(buf[pos + n:])
    x = int.from_bytes(rans[:4], "little")
    rp = 4
    bitpos = 0
    z = [[0] * (w + 4) for _ in range(h + 2)]  # 2 rows / columns of zero padding
    mask_p = PROB - 1
    for j in range(h):
        r0, r1, r2 = z[j], z[j + 1], z[j + 2]
        for i in range(2, w + 2):
            s = 3 * r2[i - 1] + 3 * r1[i] + r1[i - 1] + r1[i + 1] + r2[i - 2] + r0[i]
            c = _ctx_of_sum(s)
            slot = x & mask_p
            t = lookup[c][slot]
            x = freqs[c][t] * (x >> PROB_BITS) + slot - starts[c][t]
            while x < RANS_L:
                x = (x << 8) | rans[rp]
                rp += 1
            if t >= 16:
                e = (t - 16) >> 1
                ne = e + 3
                v = 0
                for b in range(ne):
                    v |= (bits[(bitpos + b) >> 3] >> ((bitpos + b) & 7) & 1) << b
                bitpos += ne
                t = ((2 | (t & 1)) << ne) | v
            r2[i] = t
    return np.array([row[2:w + 2] for row in z[2:]], np.int64)


# ---------------------------------------------------------------- public API
def encode_grid(q: np.ndarray) -> bytes:
    """q: 2-D integer grid whose values fit in 16 bits (signed or unsigned)."""
    q = np.asarray(q, np.int64)
    rem_src = int(q.flat[0])
    g = 0
    for v in np.unique(q - rem_src).tolist():
        g = math.gcd(g, v)
        if g == 1:
            break
    g = max(1, min(g, 65535))
    rem = rem_src % g
    qq = (q - rem) // g
    lattice = struct.pack("<HH", g, rem)
    head, z = b"\x00\x00", _zigzag(qq - _planar_pred(qq))
    if _ls_ok(*qq.shape):
        c = _fit(qq)
        z_ls = _zigzag(qq - _ls_pred(qq, c))
        if _estimate_bits(z_ls) < _estimate_bits(z):
            head, z = struct.pack(f"<BB{len(c)}i", 1, len(c), *c.tolist()), z_ls
    return head + lattice + _entropy_encode(z)


def _estimate_bits(z: np.ndarray) -> float:
    """Static-model size of _entropy_encode's output (without tables), to pick a predictor."""
    tok, nextra, _ = _tokens(z.ravel())
    ctx = _contexts(z).ravel()
    cnt = np.zeros((NCTX, NTOK))
    np.add.at(cnt, (ctx, tok), 1)
    tot = cnt.sum(1, keepdims=True)
    with np.errstate(divide="ignore", invalid="ignore"):
        ent = -np.where(cnt > 0, cnt * np.log2(cnt / np.maximum(tot, 1)), 0).sum()
    return float(ent + nextra.sum())


def decode_grid(blob: bytes | memoryview, height: int, width: int, signed: bool) -> np.ndarray:
    buf = memoryview(blob)
    kind, n = buf[0], buf[1]
    c = struct.unpack_from(f"<{n}i", buf, 2)
    pos = 2 + 4 * n
    g, rem = struct.unpack_from("<HH", buf, pos)
    z = _entropy_decode(buf, pos + 4, height, width)
    r = (z >> 1) ^ -(z & 1)
    lo_v = -32768 if signed else 0

    def fold(v):
        return ((v - lo_v) & 0xFFFF) + lo_v

    q = fold(r.cumsum(1).cumsum(0))  # planar inverse (all rows < MARGIN are final for LS too)
    if kind == 1:
        m = MARGIN
        S = sum(c)
        cww = c[OFFSETS.index((0, -2))]
        upper = [(ck, dy, dx) for ck, (dy, dx) in zip(c, OFFSETS) if dy != 0]
        half = 1 << (FRAC - 1)
        for j in range(m, height):
            row = q[j].tolist()
            prev = q[j - 1].tolist()
            rr = r[j].tolist()
            A = np.zeros(width - 2 * m, np.int64)
            for ck, dy, dx in upper:
                A += ck * q[j + dy, m + dx:width - m + dx]
            A = A.tolist()
            row[0] = fold(prev[0] + rr[0])
            for i in range(1, width):
                if m <= i < width - m:
                    W_ = row[i - 1]
                    p = W_ + ((A[i - m] + cww * row[i - 2] - S * W_ + half) >> FRAC)
                else:
                    p = row[i - 1] + prev[i] - prev[i - 1]
                row[i] = fold(p + rr[i])
            q[j] = row
    elif kind != 0:
        raise ValueError(f"unknown predictor {kind}")
    return q * g + rem
