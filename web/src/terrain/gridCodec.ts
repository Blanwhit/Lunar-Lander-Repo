// Decoder for the lossless 16-bit height-grid codec (format and encoder:
// pipeline/moonlod/gridcodec.py): lattice divisor, planar or least-squares prediction,
// per-context static rANS. Used by MLH2 height tiles and the walk-terrain grids.

const FRAC_DIV = 4096; // 2^FRAC
const FRAC_HALF = 2048;
const NCTX = 20;
const PROB_BITS = 12;
const PROB_MASK = (1 << PROB_BITS) - 1;
const RANS_L = 1 << 23;
const MARGIN = 2;
// causal neighbours (dy, dx) of the LS predictor, relative to the sample; W is the reference
const OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0], [-1, -1], [-1, 1], [0, -2], [-2, 0], [-1, -2], [-2, -1], [-2, 1], [-1, 2], [-2, -2], [-2, 2],
];

function contextOf(s: number): number {
  if (s <= 0) return 0;
  const k = 31 - Math.clz32(s);
  return Math.min(NCTX - 1, 1 + 2 * k + (s * s >= 2 ** (2 * k + 1) ? 1 : 0));
}
// every sum beyond CTX_TABLE lands in the last context
const CTX_TABLE = 1 << ((NCTX >> 1) + 1);
const CTX = Uint8Array.from({ length: CTX_TABLE }, (_, s) => contextOf(s));

/**
 * Decodes a grid block into `out` (row-major, height x width). Uint16Array means the values
 * are unsigned, Int16Array signed. A generator so callers can spread a large grid over
 * several tasks: it yields the number of rows finished so far after each row.
 */
export function* gridRows(src: Uint8Array, height: number, width: number,
  out: Uint16Array | Int16Array): Generator<number, void, void> {
  if (out.length !== height * width) throw new Error('grid size mismatch');
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const kind = src[0], nCoef = src[1];
  if (kind > 1 || (kind === 1 && nCoef !== OFFSETS.length)) throw new Error('unknown grid predictor');
  const coef = new Float64Array(nCoef);
  for (let k = 0; k < nCoef; k++) coef[k] = dv.getInt32(2 + 4 * k, true);
  let pos = 2 + 4 * nCoef;
  const g = dv.getUint16(pos, true), rem = dv.getUint16(pos + 2, true);
  pos += 4;

  const mask = dv.getUint32(pos, true);
  pos += 4;
  const freq: Uint16Array[] = [], start: Uint16Array[] = [], lookup: Uint8Array[] = [];
  for (let c = 0; c < NCTX; c++) {
    if (!((mask >>> c) & 1)) continue;
    const t = src[pos++];
    const f = new Uint16Array(t), s = new Uint16Array(t), lut = new Uint8Array(1 << PROB_BITS);
    let cum = 0;
    for (let i = 0; i < t; i++) {
      let v = 0, shift = 0, b: number;
      do { b = src[pos++]; v |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
      f[i] = v; s[i] = cum;
      lut.fill(i, cum, cum + v);
      cum += v;
    }
    if (cum !== 1 << PROB_BITS) throw new Error('corrupt grid table');
    freq[c] = f; start[c] = s; lookup[c] = lut;
  }
  const ransLen = dv.getUint32(pos, true);
  pos += 4;
  let rp = pos;
  let x = dv.getUint32(rp, true);
  rp += 4;
  let bitPos = (pos + ransLen) * 8;

  const signBias = out instanceof Int16Array ? 32768 : 0;
  const zw = width + 4; // zigzag rows with 2 columns of zero padding on each side
  const z = new Int32Array((height + 2) * zw);
  const q = new Int32Array(height * width); // values before the lattice is applied
  const ls = kind === 1 && height > MARGIN + 2 && width > 2 * MARGIN + 2;
  // unrolled LS terms (same order as OFFSETS)
  const [c0, c1, c2, c3, c4, c5, c6, c7, c8, c9, c10] = ls ? coef : new Float64Array(11);
  const W1 = width, W2 = 2 * width;

  function decodeRow(j: number) {
    const zr = (j + 2) * zw;
    for (let i = 0; i < width; i++) {
      const k = zr + i + 2;
      const s = 3 * z[k - 1] + 3 * z[k - zw] + z[k - zw - 1] + z[k - zw + 1] + z[k - 2] + z[k - 2 * zw];
      const c = s < CTX_TABLE ? CTX[s] : NCTX - 1;
      const slot = x & PROB_MASK;
      let t = lookup[c][slot];
      x = freq[c][t] * (x >>> PROB_BITS) + slot - start[c][t];
      while (x < RANS_L) x = (x << 8) | src[rp++];
      if (t >= 16) {
        const ne = ((t - 16) >> 1) + 3;
        // A 16-bit zigzag value has at most 14 extra bits, even across a byte boundary.
        const byte = bitPos >>> 3;
        const bits = src[byte] | (src[byte + 1] << 8) | (src[byte + 2] << 16);
        const v = (bits >>> (bitPos & 7)) & ((1 << ne) - 1);
        bitPos += ne;
        t = ((2 | (t & 1)) << ne) | v;
      }
      z[k] = t;
    }
    // prediction
    const row = j * width;
    for (let i = 0; i < width; i++) {
      const zz = z[zr + i + 2];
      const r = (zz >>> 1) ^ -(zz & 1);
      const k = row + i;
      let p: number;
      if (j === 0) p = i === 0 ? 0 : q[k - 1];
      else if (i === 0) p = q[k - width];
      else if (ls && j >= MARGIN && i >= MARGIN && i < width - MARGIN) {
        const w = q[k - 1], n = k - W1, nn = k - W2;
        const acc = c0 * (q[n] - w) + c1 * (q[n - 1] - w) + c2 * (q[n + 1] - w) + c3 * (q[k - 2] - w)
          + c4 * (q[nn] - w) + c5 * (q[n - 2] - w) + c6 * (q[nn - 1] - w) + c7 * (q[nn + 1] - w)
          + c8 * (q[n + 2] - w) + c9 * (q[nn - 2] - w) + c10 * (q[nn + 2] - w);
        p = w + Math.floor((acc + FRAC_HALF) / FRAC_DIV);
      } else p = q[k - 1] + q[k - width] - q[k - width - 1];
      const v = ((p + r + signBias) & 0xffff) - signBias;
      q[k] = v;
      out[k] = v * g + rem;
    }
  }
  for (let j = 0; j < height; j++) {
    decodeRow(j);
    yield j + 1;
  }
}

/** Decodes a whole grid block synchronously. */
export function decodeGrid(src: Uint8Array, height: number, width: number, out: Uint16Array | Int16Array) {
  for (const _ of gridRows(src, height, width, out));
  return out;
}
