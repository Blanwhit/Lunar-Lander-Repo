// Li & Wu (2018), equations 4–6: F(>D) = k exp[-(0.5648 + 0.01285/k)D].
// D is in metres; Diviner constrains F(>1), while k represents cover at all sizes.
export function fitCover(cover: number) {
  if (cover <= 0) return { k: 0, q: 1 };
  let lo = 0, hi = 1;
  for (let i = 0; i < 26; i++) {
    const k = (lo + hi) / 2;
    if (k * Math.exp(-0.5648 - 0.01285 / k) < cover) lo = k;
    else hi = k;
  }
  return { k: hi, q: 0.5648 + 0.01285 / hi };
}

export interface RockReading {
  cover: number | null;
  counts: number[] | null; // Surveyed number per square kilometre in three size classes.
  native: boolean;
}
export interface RockAtlas {
  read(lat: number, lon: number): RockReading;
  typicalCover: number;
  // Global cumulative counts/km² tabulated at lower diameter thresholds.
  curve: number[][];
}

export const boulderBands = [
  { min: .30, max: 1, cell: 12, radius: 70 },
  { min: 1, max: 4.5, cell: 32, radius: 250 },
  { min: 4.5, max: 10, cell: 96, radius: 800 },
  { min: 10, max: 30, cell: 256, radius: 1800 },
  { min: 30, max: 200, cell: 512, radius: 3000 },
];

// Mean exposed plan area / nominal D² across the three scanned, tilted specimens.
const footprintFactor = 0.53;
const samplesPerBand = 16;
export const maxVisiblePerBand = 1500;

export function hash(x: number, z: number, seed: number): number {
  let h = Math.imul(x, 0x1f1f1f1f) ^ Math.imul(z, 0x6c8e9cf5) ^ seed;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

// Interpolate the survey's cumulative density in log diameter and log count.
function cumulative(curve: number[][], d: number) {
  if (d <= curve[0][0]) return curve[0][1];
  for (let n = 1; n < curve.length; n++) {
    const [right, low] = curve[n], [left, high] = curve[n - 1];
    if (d <= right) {
      const t = Math.log(d / left) / Math.log(right / left);
      return low > 0 ? high * (low / high) ** t : high * (1 - t);
    }
  }
  return 0;
}

export interface PlacedBoulder { x: number; z: number; diameter: number; i: number; j: number }

export class BoulderField {
  private readonly tiles = boulderBands.map(() => new Map<string, PlacedBoulder[]>());
  constructor(readonly atlas: RockAtlas, private readonly seed: number,
    private readonly coordinates: (x: number, z: number) => { lat: number; lon: number }) {}

  tile(layer: number, col: number, row: number) {
    const cache = this.tiles[layer], key = col + '/' + row;
    let rocks = cache.get(key);
    if (rocks) return rocks;
    const band = boulderBands[layer], width = band.cell;
    const point = this.coordinates((col + .5) * width, (row + .5) * width);
    const reading = this.atlas.read(point.lat, point.lon);
    const fit = fitCover(reading.cover ?? this.atlas.typicalCover);
    const surveyed = layer >= 2 && reading.counts !== null;
    const edges = [band.min], cdf = [0];
    for (let bin = 1; bin <= samplesPerBand; bin++) {
      const a = edges[bin - 1], b = band.min * (band.max / band.min) ** (bin / samplesPerBand);
      // Convert size-resolved fractional area to expected counts per square metre.
      const weight = surveyed
        ? cumulative(this.atlas.curve, a) - cumulative(this.atlas.curve, b)
        : fit.k * (Math.exp(-fit.q * a) - Math.exp(-fit.q * b)) / (footprintFactor * a * b);
      edges.push(b); cdf.push(cdf[bin - 1] + weight);
    }
    const total = cdf[samplesPerBand];
    const density = surveyed ? reading.counts![layer - 2] / 1e6 : total;
    const expected = density * width * width;
    const seed = this.seed + 93089 * (layer + 1);
    const count = Math.floor(expected + hash(col, row, seed));
    rocks = [];
    for (let n = 0; n < count && total > 0; n++) {
      const salt = seed + Math.imul(n + 1, 74597);
      const u = hash(col, row, salt + 1) * total;
      let bin = 0;
      while (bin + 1 < samplesPerBand && u >= cdf[bin + 1]) bin++;
      const t = (u - cdf[bin]) / (cdf[bin + 1] - cdf[bin]);
      const diameter = edges[bin] * (edges[bin + 1] / edges[bin]) ** t;
      const x = (col + hash(col, row, salt + 2)) * width, z = (row + hash(col, row, salt + 3)) * width;
      // Keep the initial standing spot free. Each tile is fixed throughout the walk.
      if (x*x + z*z < (.62 * diameter + .45) ** 2) continue;
      rocks.push({ x, z, diameter, i: (hash(col, row, salt + 4) * 4294967296) | 0, j: salt });
    }
    if (cache.size >= 1024) cache.delete(cache.keys().next().value!);
    cache.set(key, rocks);
    return rocks;
  }

  nearby(layer: number, x: number, z: number, radius: number) {
    const width = boulderBands[layer].cell, result: PlacedBoulder[] = [];
    const radiusSq = radius * radius;
    for (let row = Math.floor((z-radius)/width); row <= Math.floor((z+radius)/width); row++) {
      for (let col = Math.floor((x-radius)/width); col <= Math.floor((x+radius)/width); col++) {
        for (const rock of this.tile(layer, col, row)) {
          if ((rock.x-x)**2 + (rock.z-z)**2 <= radiusSq) result.push(rock);
        }
      }
    }
    return result;
  }
}
