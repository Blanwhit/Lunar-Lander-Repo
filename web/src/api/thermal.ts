// 1-D thermophysical model of the lunar regolith (explicit finite differences), using the
// Diviner-calibrated parameters of Hayne et al. (2017), "Global regolith thermophysical
// properties of the Moon from the Diviner Lunar Radiometer Experiment", JGR Planets 122.
//
// Driven by the absorbed solar flux history at the site (terrain-shadowed, slope-aware),
// it returns the surface temperature at the end of the series. Not modelled: sunlight
// scattered and thermal IR emitted by surrounding terrain -- so temperatures inside
// permanently shadowed regions and on shadowed crater walls are lower bounds.

export const SIGMA = 5.670374e-8;
export const EMISSIVITY = 0.95;
export const ALBEDO0 = 0.12;
const RHO_S = 1100, RHO_D = 1800, H = 0.06; // kg/m^3, kg/m^3, m
const K_S = 7.4e-4, K_D = 3.4e-3, CHI = 2.7; // W/m/K, W/m/K, radiative coefficient
const Q_GEO = 0.018; // W/m^2 geothermal flux

/** incidence-dependent Bond albedo (Keihm 1984; Hayne et al. 2017), i in degrees */
export function albedo(iDeg: number): number {
  return ALBEDO0 + 0.06 * Math.pow(iDeg / 45, 3) + 0.25 * Math.pow(iDeg / 90, 8);
}

export interface ThermalResult {
  surfaceK: number;
  /** temperature ~0.5 m deep (close to the long-term mean) */
  deepK: number;
}

/**
 * @param absorbed absorbed flux at the surface (W/m^2), equally spaced, oldest first
 * @param sampleS  spacing of `absorbed` in seconds
 */
export function simulateRegolith(absorbed: Float64Array, sampleS: number): ThermalResult {
  // grid: 36 nodes, 5 mm at the top growing geometrically to ~2.5 m
  const N = 36;
  const z = new Float64Array(N);
  let dz = 0.005;
  for (let i = 1; i < N; i++) {
    z[i] = z[i - 1] + dz;
    dz *= 1.12;
  }
  const rho = new Float64Array(N), kc = new Float64Array(N), w = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    rho[i] = RHO_D - (RHO_D - RHO_S) * Math.exp(-z[i] / H);
    kc[i] = K_D - ((K_D - K_S) * (RHO_D - rho[i])) / (RHO_D - RHO_S);
    const hl = i > 0 ? z[i] - z[i - 1] : 0, hr = i < N - 1 ? z[i + 1] - z[i] : z[i] - z[i - 1];
    w[i] = (hl + hr) / 2 || hr / 2; // control-volume width (half cell at the surface)
  }
  w[0] = (z[1] - z[0]) / 2;

  // initial state: long-term equilibrium with the mean absorbed flux (+ geothermal)
  let mean = 0;
  for (let k = 0; k < absorbed.length; k++) mean += absorbed[k];
  mean /= Math.max(1, absorbed.length);
  const t0 = Math.max(Math.pow((mean + Q_GEO) / (EMISSIVITY * SIGMA), 0.25) * 0.86, 20);
  const T = new Float64Array(N).fill(t0);
  // per-interface constants: mean conductivity and node spacing between nodes i and i + 1
  const kHalf = new Float64Array(N - 1), dzi = new Float64Array(N - 1);
  for (let i = 0; i < N - 1; i++) {
    kHalf[i] = 0.5 * (kc[i] + kc[i + 1]);
    dzi[i] = z[i + 1] - z[i];
  }
  const rw = new Float64Array(N); // rho * width: heat capacity per kelvin is rw * c(T)
  for (let i = 0; i < N; i++) rw[i] = rho[i] * w[i];
  const flux = new Float64Array(N - 1); // flux from node i + 1 into node i (W/m^2)
  const ES = EMISSIVITY * SIGMA;

  const total = (absorbed.length - 1) * sampleS;
  const dt = 120; // s (stable for the top cell incl. radiative stiffness)
  const last = absorbed.length - 1;
  for (let t = 0; t < total; t += dt) {
    const x = t / sampleS, k = Math.floor(x), f = x - k;
    const F = absorbed[k] * (1 - f) + absorbed[Math.min(k + 1, last)] * f;
    // each interface flux once (it enters one node and leaves the other)
    for (let i = 0; i < N - 1; i++) {
      const r = (0.5 * (T[i] + T[i + 1])) / 350;
      flux[i] = (kHalf[i] * (1 + CHI * r * r * r) * (T[i + 1] - T[i])) / dzi[i];
    }
    // explicit update in place: every flux was taken from the old temperatures
    for (let i = 0; i < N; i++) {
      const Ti = T[i];
      let q: number;
      if (i === 0) {
        const T2 = Ti * Ti;
        q = flux[0] + (F - ES * T2 * T2);
      } else if (i === N - 1) q = Q_GEO - flux[i - 1];
      else q = flux[i] - flux[i - 1];
      const c = -3.6125 + Ti * (2.7431 + Ti * (2.3616e-3 + Ti * (-1.234e-5 + Ti * 8.9093e-9)));
      T[i] = Math.max(3, Ti + (dt * q) / (rw[i] * Math.max(c, 5)));
    }
  }
  let deep = T[N - 1];
  for (let i = 0; i < N; i++) if (z[i] >= 0.5) { deep = T[i]; break; }
  return { surfaceK: T[0], deepK: deep };
}
