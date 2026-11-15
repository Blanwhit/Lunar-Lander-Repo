// The 65 by 65 displacement grid covers one half-metre soil tile, including its edges.
const samples = 65 * 65;
export type CastSoilTile = { x: number; z: number; revision: number; heights: string };

export function encodeSoil(heights: Float32Array) {
  const bytes: number[] = [];
  for (let i = 0; i < heights.length;) {
    const depth = Math.max(-32768, Math.min(32767, Math.round(heights[i++] * 10000)));
    if (depth === 0) {
      let count = 1;
      while (count < 256 && i < heights.length && Math.round(heights[i] * 10000) === 0) {
        count++; i++;
      }
      bytes.push(0, count - 1);
    } else if (depth >= -126 && depth <= 127) {
      bytes.push(depth + 127);
    } else {
      bytes.push(255, depth & 255, (depth >> 8) & 255);
    }
  }
  return btoa(String.fromCharCode(...bytes));
}

export function decodeSoil(encoded: string) {
  if (typeof encoded !== 'string' || encoded.length > samples * 4) return;
  let bytes: string;
  try { bytes = atob(encoded); } catch { return; }
  const heights = new Float32Array(samples);
  let i = 0, pos = 0;
  while (i < bytes.length && pos < samples) {
    const code = bytes.charCodeAt(i++);
    if (code === 0) {
      if (i >= bytes.length) return;
      pos += bytes.charCodeAt(i++) + 1;
    } else if (code === 255) {
      if (i + 2 > bytes.length) return;
      const value = bytes.charCodeAt(i++) | (bytes.charCodeAt(i++) << 8);
      heights[pos++] = ((value << 16) >> 16) / 10000;
    } else {
      heights[pos++] = (code - 127) / 10000;
    }
  }
  return pos === samples && i === bytes.length ? heights : undefined;
}
