// Feasibility score (0-100 %) for a landing site, shared by the site API and the viewer
// overlay so both produce identical numbers from the same inputs.
//
// Three tiers:
//  1. every sub-factor -> 0..100 through a piecewise-linear utility curve; a curve may
//     declare a knockout (e.g. slope > 15 deg) which zeroes the final score
//  2. sub-factors -> category scores (power, comms, landing) and categories -> overall
//     with a weighted power mean  M_p = (sum w_i s_i^p)^(1/p), p < 0 = weakest link dominates
//  3. gates on critical categories: g = 1 if s >= tau else (s/tau)^k;
//     final = clamp(G * M, 1, 100), G = product of gates (0 on any knockout)
//
// One penalty for weak categories, not three stacked ones: the default is the geometric
// mean (p = 0) with soft Power/Comms gates (tau = 10, k = 1), which only bite when a category
// is nearly absent. Power and Comms are scored for equipment on a mast (panel / antenna
// height above the ground) and count a body as visible down to horizonToleranceDeg below the
// terrain horizon (DEM error at the ~20 m polar grid, diffraction at grazing angles).
//
// All numbers below are PLACEHOLDERS to be replaced by the lander's real tolerances.
// Any sub-score near 0 drags its whole category down regardless of its weight, so curves of
// non-critical factors (temperature, prominence) keep a non-zero floor.

export type Curve = [x: number, utility: number][]; // breakpoints, x ascending

export interface SubFactor {
  weight: number;
  curve: Curve;
  /** inputs outside [knockoutBelow, knockoutAbove] make the site impossible */
  knockoutBelow?: number;
  knockoutAbove?: number;
  label: string;
  unit: string;
}

export type PowerKey = 'sunVisibleNow' | 'sunHoursRemaining' | 'annualIllumination';
export type CommsKey = 'earthVisibleNow' | 'linkMarginDeg' | 'earthHoursRemaining' | 'annualEarthVisibility';
export type LandingKey = 'slopeDeg' | 'temperatureK' | 'prominenceM';
export type FactorKey = PowerKey | CommsKey | LandingKey;
export type Category = 'power' | 'comms' | 'landing';

export interface FeasibilityConfig {
  p: number; // power-mean exponent (used inside categories and across categories; 0 = geometric)
  /** height of the solar panel above the ground for the Power inputs (m) */
  panelHeightM: number;
  /** height of the Earth antenna above the ground for the Comms inputs (m) */
  antennaHeightM: number;
  /** a body counts as visible while its margin above the terrain horizon is > -this (deg) */
  horizonToleranceDeg: number;
  categoryWeights: Record<Category, number>;
  gates: Record<Category, { tau: number; k: number } | null>;
  factors: {
    power: Record<PowerKey, SubFactor>;
    comms: Record<CommsKey, SubFactor>;
    landing: Record<LandingKey, SubFactor>;
  };
}

export type FeasibilityInputs = Record<FactorKey, number>;

export interface FeasibilityResult {
  score: number; // final 1..100 (%)
  combined: number; // power mean of the categories before gating
  gate: number; // G
  knockouts: FactorKey[];
  categories: Record<Category, number>;
  subScores: Record<FactorKey, number>;
}

const H = 1, D = 24; // hours, days
export const DEFAULT_FEASIBILITY: FeasibilityConfig = {
  p: 0,
  // the overlay's horizons and annual statistics are baked by pipeline/feasibility_grid.py at
  // one mast height (MAST_H) and tolerance (HORIZON_TOL): keep those equal to these
  panelHeightM: 10,
  antennaHeightM: 10,
  horizonToleranceDeg: 0.4,
  categoryWeights: { comms: 0.25, power: 0.25, landing: 0.5 },
  gates: { landing: { tau: 40, k: 2 }, power: { tau: 10, k: 1 }, comms: { tau: 10, k: 1 } },
  factors: {
    power: {
      sunVisibleNow: { weight: 0.35, curve: [[0, 0], [1, 100]], label: 'Sun visible now', unit: 'disc fraction' },
      sunHoursRemaining: {
        weight: 0.35, curve: [[0, 0], [24 * H, 40], [7 * D, 80], [14 * D, 100]],
        label: 'sunlight remaining', unit: 'h',
      },
      annualIllumination: {
        weight: 0.3, curve: [[0, 0], [0.3, 40], [0.6, 80], [0.9, 100]],
        label: 'annual illumination', unit: 'fraction of time',
      },
    },
    comms: {
      earthVisibleNow: { weight: 0.3, curve: [[0, 0], [1, 100]], label: 'Earth visible now', unit: 'disc fraction' },
      linkMarginDeg: {
        weight: 0.2, curve: [[0, 0], [2, 60], [10, 100]],
        label: 'Earth elevation above terrain', unit: 'deg',
      },
      earthHoursRemaining: {
        weight: 0.25, curve: [[0, 0], [24 * H, 40], [7 * D, 80], [14 * D, 100]],
        label: 'Earth contact remaining', unit: 'h',
      },
      annualEarthVisibility: {
        weight: 0.25, curve: [[0, 0], [0.5, 70], [1, 100]],
        label: 'annual Earth visibility', unit: 'fraction of time',
      },
    },
    landing: {
      slopeDeg: {
        weight: 0.6, curve: [[0, 100], [5, 100], [10, 50], [15, 0]], knockoutAbove: 15,
        label: 'slope', unit: 'deg',
      },
      temperatureK: {
        weight: 0.3, curve: [[40, 10], [100, 70], [130, 100], [360, 100], [420, 30]],
        label: 'surface temperature', unit: 'K',
      },
      prominenceM: {
        weight: 0.1, curve: [[-500, 40], [0, 80], [300, 100]],
        label: 'local prominence (height above surroundings)', unit: 'm',
      },
    },
  },
};

/** piecewise-linear utility, clamped to the end values */
export function utility(curve: Curve, x: number): number {
  if (!(x === x)) return 0; // NaN
  if (x <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    const [x1, y1] = curve[i];
    if (x <= x1) {
      const [x0, y0] = curve[i - 1];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return curve[curve.length - 1][1];
}

/** weighted power mean of scores in 0..100 (scores floored at 1 so p < 0 stays finite) */
export function powerMean(scores: number[], weights: number[], p: number): number {
  const wsum = weights.reduce((a, b) => a + b, 0) || 1;
  if (Math.abs(p) < 1e-6) {
    let l = 0;
    for (let i = 0; i < scores.length; i++) l += (weights[i] / wsum) * Math.log(Math.max(scores[i], 1));
    return Math.exp(l);
  }
  let s = 0;
  for (let i = 0; i < scores.length; i++) s += (weights[i] / wsum) * Math.pow(Math.max(scores[i], 1), p);
  return Math.pow(s, 1 / p);
}

/**
 * The final score only, for evaluating many samples (the overlay worker): the config is
 * flattened once and each call does the same arithmetic in the same order as feasibility(),
 * without building the breakdown objects. feasibilityScorer(cfg)(inp) === feasibility(inp, cfg).score.
 */
export function feasibilityScorer(cfg: FeasibilityConfig = DEFAULT_FEASIBILITY): (inp: FeasibilityInputs) => number {
  const cats: Category[] = ['power', 'comms', 'landing'];
  const groups = cats.map((cat) => Object.entries(cfg.factors[cat] as Record<string, SubFactor>));
  const keys = groups.map((g) => g.map(([k]) => k as FactorKey));
  const facs = groups.map((g) => g.map(([, f]) => f));
  const weights = facs.map((fs) => fs.map((f) => f.weight));
  const catWeights = cats.map((c) => cfg.categoryWeights[c]);
  const gates = cats.map((c) => cfg.gates[c]);
  const sub = facs.map((fs) => new Array<number>(fs.length));
  const catScores = new Array<number>(cats.length);
  return (inp) => {
    let knocked = false;
    for (let c = 0; c < cats.length; c++) {
      const fs = facs[c], ks = keys[c], s = sub[c];
      for (let i = 0; i < fs.length; i++) {
        const x = inp[ks[i]], f = fs[i];
        s[i] = utility(f.curve, x);
        if ((f.knockoutAbove !== undefined && x > f.knockoutAbove) || (f.knockoutBelow !== undefined && x < f.knockoutBelow))
          knocked = true;
      }
      catScores[c] = powerMean(s, weights[c], cfg.p);
    }
    const combined = powerMean(catScores, catWeights, cfg.p);
    let G = knocked ? 0 : 1;
    for (let c = 0; c < cats.length; c++) {
      const g = gates[c];
      if (g && catScores[c] < g.tau) G *= Math.pow(catScores[c] / g.tau, g.k);
    }
    return Math.min(100, Math.max(1, G * combined));
  };
}

export function feasibility(inp: FeasibilityInputs, cfg: FeasibilityConfig = DEFAULT_FEASIBILITY): FeasibilityResult {
  const subScores = {} as Record<FactorKey, number>;
  const knockouts: FactorKey[] = [];
  const categories = {} as Record<Category, number>;
  for (const cat of ['power', 'comms', 'landing'] as Category[]) {
    const facs = cfg.factors[cat] as Record<string, SubFactor>;
    const s: number[] = [], w: number[] = [];
    for (const [k, f] of Object.entries(facs)) {
      const x = inp[k as FactorKey];
      const u = utility(f.curve, x);
      subScores[k as FactorKey] = u;
      if ((f.knockoutAbove !== undefined && x > f.knockoutAbove) || (f.knockoutBelow !== undefined && x < f.knockoutBelow))
        knockouts.push(k as FactorKey);
      s.push(u);
      w.push(f.weight);
    }
    categories[cat] = powerMean(s, w, cfg.p);
  }
  const cats: Category[] = ['power', 'comms', 'landing'];
  const combined = powerMean(cats.map((c) => categories[c]), cats.map((c) => cfg.categoryWeights[c]), cfg.p);
  let G = knockouts.length ? 0 : 1;
  for (const c of cats) {
    const g = cfg.gates[c];
    if (g && categories[c] < g.tau) G *= Math.pow(categories[c] / g.tau, g.k);
  }
  return {
    score: Math.min(100, Math.max(1, G * combined)),
    combined,
    gate: G,
    knockouts,
    categories,
    subScores,
  };
}
