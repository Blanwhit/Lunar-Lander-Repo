// Sun and Earth positions seen from the Moon (ICRF, Moon-centred, light-time corrected),
// sampled every 6 h from JPL Horizons by pipeline/ephemeris.py. One file per year
// (~69 KB), loaded on demand and cubic-Hermite interpolated (positions + velocities).
import { jdTdb } from './time';
import type { Vec3 } from './geom';

interface YearData {
  jd0: number;
  step: number; // days
  n: number;
  data: Float32Array; // n * 2 bodies * 6
}

export interface EphemIndex {
  start: number;
  end: number;
}

export interface BodyStates {
  sun: Vec3; // km, ICRF, Moon-centred
  earth: Vec3;
}

export class Ephemeris {
  private years = new Map<number, Promise<YearData>>();
  index: EphemIndex = { start: 2000, end: 2050 };

  constructor(private baseUrl: string, private fetchImpl: typeof fetch = fetch.bind(globalThis)) {}

  async init(): Promise<void> {
    this.index = await this.fetchImpl(this.baseUrl + 'index.json').then((r) => r.json());
  }

  /** inclusive UTC range covered by the data */
  range(): [number, number] {
    return [Date.UTC(this.index.start, 0, 1), Date.UTC(this.index.end, 11, 31, 23, 59)];
  }

  private year(y: number): Promise<YearData> {
    let p = this.years.get(y);
    if (!p) {
      p = this.fetchImpl(`${this.baseUrl}${y}.bin`)
        .then((r) => {
          if (!r.ok) throw new Error(`ephemeris ${y}: HTTP ${r.status}`);
          return r.arrayBuffer();
        })
        .then((buf) => {
          const dv = new DataView(buf);
          if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== 'MEPH')
            throw new Error('bad ephemeris file');
          const jd0 = dv.getFloat64(8, true);
          const step = dv.getFloat64(16, true);
          const n = dv.getUint32(24, true);
          return { jd0, step, n, data: new Float32Array(buf, 32, n * 12) };
        });
      this.years.set(y, p);
      p.catch(() => this.years.delete(y));
    }
    return p;
  }

  /** states at a UTC timestamp (ms) */
  async at(ms: number): Promise<BodyStates> {
    const y = Math.min(this.index.end, Math.max(this.index.start, new Date(ms).getUTCFullYear()));
    const Y = await this.year(y);
    // near a year boundary, prefetch the neighbouring year so stepping across it is seamless
    const month = new Date(ms).getUTCMonth();
    if (month === 11 && y + 1 <= this.index.end) void this.year(y + 1).catch(() => {});
    if (month === 0 && y - 1 >= this.index.start) void this.year(y - 1).catch(() => {});
    const jd = jdTdb(ms);
    const f = (jd - Y.jd0) / Y.step;
    const i = Math.min(Y.n - 2, Math.max(0, Math.floor(f)));
    const s = f - i;
    const h = Y.step * 86400; // s
    const s2 = s * s, s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
    const body = (b: number): Vec3 => {
      const o0 = (i * 2 + b) * 6, o1 = ((i + 1) * 2 + b) * 6, d = Y.data;
      return [0, 1, 2].map((k) =>
        h00 * d[o0 + k] + h10 * h * d[o0 + 3 + k] + h01 * d[o1 + k] + h11 * h * d[o1 + 3 + k],
      ) as Vec3;
    };
    return { sun: body(0), earth: body(1) };
  }
}
