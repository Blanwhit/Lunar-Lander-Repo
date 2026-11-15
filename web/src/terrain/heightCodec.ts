// Decoder for MLH2 height tiles (format: pipeline/moonlod/heights.py). Shared by the
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

export async function decodeHeightTile(compressed: ArrayBuffer): Promise<DecodedHeightTile> {
  const dv = new DataView(compressed);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'MLH2') throw new Error('bad magic');
  const G = dv.getUint16(32, true);
  if (G !== GRID) throw new Error('grid mismatch');
  const q = decodeGrid(new Uint8Array(compressed, HEADER_BYTES), G, G, new Uint16Array(G * G)) as Uint16Array;
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
