// "More info" debug-style overlay: monospace lines on translucent strips in the top-left
// corner, grouped as power / connectivity / landing, each ending in its category score,
// and the combined (colour-coded) feasibility score. All values come from the site API
// report (api/siteApi.ts).
import { DEFAULT_FEASIBILITY } from './api/feasibility';
import type { SiteReport } from './api/siteApi';
import { scoreTier } from './sitePopup';

const CSS = `
.moon-info {
  position: fixed; top: max(12px, env(safe-area-inset-top)); left: 12px; z-index: 3;
  max-width: calc(100vw - 24px); max-height: calc(100vh - 140px); overflow-y: auto; box-sizing: border-box;
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
  font: 500 13px/1.25 ui-monospace, "Cascadia Mono", Consolas, "SFMono-Regular", Menlo, monospace;
  color: #f1f3f4; text-shadow: 1px 1px 0 rgba(0,0,0,0.75);
  scrollbar-width: thin;
}
.moon-info[hidden] { display: none; }
.moon-info .ln { background: rgba(40, 40, 40, 0.62); padding: 1px 6px; white-space: pre; }
.moon-info .gap { height: 8px; }
.moon-info .hd { color: #fde26a; }
.moon-info .title { color: #fff; font-weight: 700; display: flex; align-items: center; gap: 10px; }
.moon-info .title button { all: unset; cursor: pointer; color: #9aa0a6; padding: 0 4px; border-radius: 3px; text-shadow: none; }
.moon-info .title button:hover { color: #fff; background: rgba(255,255,255,0.12); }
.moon-info .title button:focus-visible { outline: 1px solid #8ab4f8; }
.moon-info .dim { color: #9aa0a6; }
.moon-info .good { color: #5bd77a; }
.moon-info .fair { color: #fde26a; }
.moon-info .poor { color: #f28b82; }
.moon-info .score { font-weight: 700; }
.moon-info .total { margin-top: 2px; padding: 4px 8px; font-size: 15px; font-weight: 700; border-left: 4px solid; }
.moon-info .total.good { background: rgba(33, 178, 69, 0.38); border-color: #21b245; color: #fff; }
.moon-info .total.fair { background: rgba(250, 214, 41, 0.30); border-color: #fad629; color: #fff; }
.moon-info .total.poor { background: rgba(219, 31, 23, 0.40); border-color: #db1f17; color: #fff; }
@media (max-width: 560px) { .moon-info { font-size: 11.5px; max-height: calc(100vh - 190px); } }
`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const pct = (f: number) => `${Math.round(f * 100)}%`;
const deg = (v: number, d = 1) => `${v >= 0 ? '' : '−'}${Math.abs(v).toFixed(d)}°`;

/** minutes -> "3d 04h 12m" */
function dur(min: number): string {
  const m = Math.max(0, Math.round(min));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d) return `${d}d ${String(h).padStart(2, '0')}h ${String(mm).padStart(2, '0')}m`;
  if (h) return `${h}h ${String(mm).padStart(2, '0')}m`;
  return `${mm}m`;
}
const utc = (iso: string) => iso.replace('T', ' ').replace(/:\d\d(\.\d+)?Z$/, ' UTC');

/** "Sunset in 5d 03h 20m (2026-12-03 23:10 UTC)" style line for whichever event comes next */
function eventLine(visible: boolean, riseName: string, setName: string,
  minRise: number | null, minSet: number | null, isoRise: string | null, isoSet: string | null, days: number): string {
  const [name, min, iso] = visible ? [setName, minSet, isoSet] : [riseName, minRise, isoRise];
  if (min === null || iso === null) return `${name} in: <span class="dim">none within ${days} d</span>`;
  return `${name} in: ${dur(min)} <span class="dim">(${esc(utc(iso))})</span>`;
}

function scoreSpan(s: number): string {
  return `<span class="score ${scoreTier(s)}">${Math.round(s)}%</span>`;
}

export class InfoPanel {
  private el: HTMLDivElement;
  /** called when the panel is closed with its own close button */
  onClose: () => void = () => {};

  constructor(parent: HTMLElement) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    this.el = document.createElement('div');
    this.el.className = 'moon-info';
    this.el.setAttribute('role', 'region');
    this.el.setAttribute('aria-label', 'Site details');
    this.el.setAttribute('aria-live', 'polite');
    this.el.hidden = true;
    this.el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-close]')) {
        this.hide();
        this.onClose();
      }
    });
    for (const ev of ['pointerdown', 'wheel', 'contextmenu'] as const) this.el.addEventListener(ev, (e) => e.stopPropagation());
    parent.appendChild(this.el);
  }

  get isOpen() {
    return !this.el.hidden;
  }

  show() {
    this.el.hidden = false;
  }

  hide() {
    this.el.hidden = true;
  }

  private title(extra = '') {
    return `<div class="ln title"><span>Site details${extra}</span><button type="button" data-close aria-label="Close details">[x]</button></div>`;
  }

  setLoading(lat: number, lon: number) {
    this.el.innerHTML = this.title() +
      `<div class="ln">Lat / Lon: ${deg(lat, 3)} / ${deg(lon, 3)}</div>` +
      `<div class="gap"></div><div class="ln dim">Computing site report...</div>`;
  }

  setError() {
    this.el.innerHTML = this.title() + `<div class="gap"></div><div class="ln poor">Site report unavailable</div>`;
  }

  setReport(r: SiteReport) {
    const q = r.query;
    const lon = ((((q.lon + 180) % 360) + 360) % 360) - 180;
    const f = r.feasibility;
    const days = r.earthEvents.searchDays;
    const L: string[] = [];
    const ln = (html: string, cls = '') => L.push(`<div class="ln${cls ? ' ' + cls : ''}">${html}</div>`);
    const gap = () => L.push('<div class="gap"></div>');

    L.push(this.title());
    ln(`Lat / Lon: ${deg(q.lat, 3)} / ${deg(lon, 3)}`);
    ln(`Time: ${esc(utc(q.timeUtc))}`);

    gap();
    ln('Power', 'hd');
    ln(`Sun visible: ${pct(r.power.sunVisibleFraction)} <span class="dim">(${r.power.status})</span>`);
    ln(`Sun elevation: ${deg(r.sun.elevationDeg)} <span class="dim">(terrain horizon ${deg(r.sun.horizonElevationDeg)})</span>`);
    ln(eventLine(r.power.sunVisibleFraction > 0, 'Sunrise', 'Sunset', r.power.minutesUntilSunrise, r.power.minutesUntilSunset,
      r.power.nextSunrise, r.power.nextSunset, days));
    ln(`Power score: ${scoreSpan(f.categories.power)}`);

    gap();
    ln('Connectivity', 'hd');
    ln(`Earth visible: ${pct(r.earthConnectivity.visibleFraction)} <span class="dim">(${r.earthConnectivity.status})</span>`);
    ln(`Earth elevation: ${deg(r.earth.elevationDeg)} <span class="dim">(terrain horizon ${deg(r.earth.horizonElevationDeg)})</span>`);
    ln(eventLine(r.earthEvents.visibleNow, 'Earthrise', 'Earthset', r.earthEvents.minutesUntilEarthrise,
      r.earthEvents.minutesUntilEarthset, r.earthEvents.nextEarthrise, r.earthEvents.nextEarthset, days));
    ln(`Connectivity score: ${scoreSpan(f.categories.comms)}`);

    gap();
    ln('Landing', 'hd');
    ln(`Temperature: ${r.temperature.surfaceK.toFixed(1)} K <span class="dim">(${r.temperature.surfaceC.toFixed(1)} °C, ${r.temperature.regime})</span>`);
    ln(`Elevation: ${Math.round(r.elevation.heightM).toLocaleString('en-US')} m <span class="dim">(vs 1737.4 km sphere)</span>`);
    ln(`Slope: ${deg(r.slope.slopeDeg)}${r.slope.aspectDeg !== null ? ` <span class="dim">(facing ${Math.round(r.slope.aspectDeg)}°)</span>` : ''}`);
    ln(`Landing score: ${scoreSpan(f.categories.landing)}`);

    gap();
    const t = scoreTier(f.score);
    L.push(`<div class="ln total ${t}">Feasibility score: ${Math.round(f.score)}%</div>`);
    if (f.knockouts.length) ln(`Ruled out by: ${f.knockouts.join(', ')}`, 'poor');
    else if (f.gate < 0.999) {
      // categories below their gate threshold are what pulled the final score down
      const weak = (['power', 'comms', 'landing'] as const).filter((c) => {
        const g = DEFAULT_FEASIBILITY.gates[c];
        return g !== null && f.categories[c] < g.tau;
      });
      if (weak.length) ln(`Limited by: ${weak.map((c) => (c === 'comms' ? 'connectivity' : c)).join(', ')}`, 'dim');
    }
    this.el.innerHTML = L.join('');
  }
}
