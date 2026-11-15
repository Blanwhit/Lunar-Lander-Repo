// Decoder for MLH1 and MLH2 height tiles (format: pipeline/moonlod/heights.py). Shared by the
// viewer's worker and the headless site API. Works in browsers and Node 18+.
import { GRID } from '../geom';
import { decodeGrid } from './gridCodec';

const HEADER_BYTES = 36;

export interface DecodedHeightTile {
  level: number;
  face: number;
  x: number;
  y: number;
  childMask: number;
  hmin: number;
  hmax: number;
  base: number; // height = base + q * step (metres vs the 1737.4 km sphere)
  step: number;
  q: Uint16Array; // GRID * GRID samples, row = b index, col = a index, 1-sample border
}

function decodeLegacyGrid(raw:ArrayBuffer,G:number) {
  const n = G * G;
  const lo = new Uint8Array(raw, 36, n);
  const hi = new Uint8Array(raw, 36 + n, n);
  const q = new Uint16Array(n);
  for (let j = 0; j < G; j++) {
    const row = j * G;
    for (let i = 0; i < G; i++) {
      const k = row + i;
      const z = lo[k] | (hi[k] << 8);
      const r = (z >>> 1) ^ -(z & 1);
      let p: number;
      if (j === 0) p = i === 0 ? 0 : q[k - 1];
      else if (i === 0) p = q[k - G];
      else p = q[k - 1] + q[k - G] - q[k - G - 1];
      q[k] = (p + r) & 0xffff;
    }
  }
  return q;
}

export async function decodeHeightTile(compressed: ArrayBuffer): Promise<DecodedHeightTile> {
  const modern = new DataView(compressed).getUint32(0) === 0x4d4c4832; // MLH2
  const raw = modern ? compressed : await new Response(
    new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate')),
  ).arrayBuffer();
  const dv = new DataView(raw);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== (modern ? 'MLH2' : 'MLH1')) throw new Error('bad magic');
  const G = dv.getUint16(32, true);
  if (G !== GRID) throw new Error('grid mismatch');
  const q = modern ? decodeGrid(new Uint8Array(raw, HEADER_BYTES), G, G, new Uint16Array(G * G)) as Uint16Array
    : decodeLegacyGrid(raw,G);
  return {
    level: dv.getUint8(4),
    face: dv.getUint8(5),
    childMask: dv.getUint8(6),
    x: dv.getUint32(8, true),
    y: dv.getUint32(12, true),
    hmin: dv.getFloat32(16, true),
    hmax: dv.getFloat32(20, true),
    step: dv.getFloat32(24, true),
    base: dv.getFloat32(28, true),
    q,
  };
}
