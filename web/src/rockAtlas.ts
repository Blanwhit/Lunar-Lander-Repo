import type { RockAtlas } from './boulderField';

const base = import.meta.env.BASE_URL + 'lunar-rocks/';
const noData = 65535;
const wrap = (lon: number) => ((lon % 360) + 360) % 360;

async function readWords(file: string, length: number) {
  const res = await fetch(base + file);
  if (!res.ok || !res.body) throw new Error('Could not load rock survey: ' + file);
  const bytes = await new Response(res.body.pipeThrough(new DecompressionStream('deflate'))).arrayBuffer();
  if (bytes.byteLength !== length * 2) throw new Error('Incomplete rock survey: ' + file);
  return new Uint16Array(bytes);
}

interface SurveyIndex {
  width: number; height: number; west: number; north: number; pixelsPerDegree: number;
  logScale: number; diameterCumulative: number[][];
}

function readCover(grid: Uint16Array, width: number, north: number, west: number, ppd: number,
  lat: number, lon: number) {
  const x = Math.floor(wrap(lon - west) * ppd), y = Math.floor((north - lat) * ppd);
  if (x >= width || y < 0 || y >= grid.length / width) return null;
  const code = grid[y * width + x];
  return code === noData ? null : code / 65534;
}

async function load(): Promise<RockAtlas> {
  const [index, counts, atlas, apollo, tycho] = await Promise.all([
    fetch(base + 'boulder-counts.json').then(async res => {
      if (!res.ok) throw new Error('Could not load boulder survey index');
      return await res.json() as SurveyIndex;
    }),
    readWords('boulder-counts.u16.z', 2880 * 960 * 3),
    readWords('abundance.bin.z', 2880 * 1280),
    readWords('abundance-apollo17.bin.z', 256 ** 2),
    readWords('abundance-tycho.bin.z', 256 ** 2),
  ]);
  return {
    typicalCover: 0.00343028,
    curve: index.diameterCumulative,
    read(lat, lon) {
      const fine = readCover(apollo, 256, 21, 30, 128, lat, lon)
        ?? readCover(tycho, 256, -42, 348, 128, lat, lon);
      const cover = fine ?? readCover(atlas, 2880, 80, 0, 8, lat, lon);
      const x = Math.floor(wrap(lon - index.west) * index.pixelsPerDegree);
      const y = Math.floor((index.north - lat) * index.pixelsPerDegree);
      const offset = 3 * (y * index.width + x);
      const observed = y >= 0 && y < index.height && counts[offset] !== noData;
      return { cover, native: fine !== null, counts: observed
        ? [0, 1, 2].map(i => Math.expm1(counts[offset + i] / index.logScale)) : null };
    },
  };
}

let pending: Promise<RockAtlas> | undefined;
export function loadRockAtlas() {
  return pending ??= load().catch(error => { pending = undefined; throw error; });
}
