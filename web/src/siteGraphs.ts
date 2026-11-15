// "More info" graphs: power, Earth-connectivity and feasibility scores of the inspected
// site over a time window starting at the simulation time, in a panel on the right. A row of
// buttons picks the window; hovering a chart shows the values at that time on all three.
// Data: SiteApi.timeSeries (api/siteApi.ts).
import type { SiteSeries } from './api/siteApi';

export interface Span {
  label: string;
  ms: number;
}

const H = 3600e3, D = 24 * H;
export const SPANS: Span[] = [
  { label: '1 day', ms: D },
  { label: '3 days', ms: 3 * D },
  { label: '1 week', ms: 7 * D },
  { label: '1 month', ms: 30 * D },
  { label: '3 months', ms: 91 * D },
  { label: '1 year', ms: 365 * D },
];
export const DEFAULT_SPAN = SPANS[3];

type Key = 'power' | 'comms' | 'feasibility';
const CHARTS: { key: Key; title: string; color: string }[] = [
  { key: 'power', title: 'Power availability', color: '#fbbc04' },
  { key: 'comms', title: 'Earth connectivity', color: '#8ab4f8' },
  { key: 'feasibility', title: 'Feasibility', color: '#c58af9' },
];

// chart geometry (SVG user units = CSS px at the panel's natural width)
const W = 380, CH = 118, PL = 34, PR = 8, PT = 8, PB = 20;
const PW = W - PL - PR, PH = CH - PT - PB;
const GRID = [0, 40, 70, 100]; // score tier boundaries (sitePopup.scoreTier)

const CSS = `
.moon-graphs {
  position: fixed; top: max(12px, env(safe-area-inset-top)); right: 12px; z-index: 3;
  width: min(412px, calc(100vw - 24px)); max-height: calc(100vh - 130px); overflow-y: auto; box-sizing: border-box;
  padding: 12px 14px 10px; display: flex; flex-direction: column; gap: 6px;
  background: rgba(32, 33, 36, 0.86); border-radius: 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.6);
  font: 500 13px/1.3 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #e8eaed;
  scrollbar-width: thin; user-select: none; -webkit-user-select: none;
}
.moon-graphs[hidden] { display: none; }
.moon-graphs .spans { display: flex; flex-wrap: wrap; gap: 6px; }
.moon-graphs .spans button { all: unset; cursor: pointer; padding: 4px 10px; border-radius: 999px;
  border: 1px solid #5f6368; color: #bdc1c6; font-size: 12px; font-weight: 600; white-space: nowrap; }
.moon-graphs .spans button:hover { background: rgba(255,255,255,0.08); color: #e8eaed; }
.moon-graphs .spans button[aria-pressed="true"] { background: #8ab4f8; border-color: #8ab4f8; color: #202124; }
.moon-graphs .spans button:focus-visible { outline: 2px solid #8ab4f8; outline-offset: 2px; }
.moon-graphs .when { color: #9aa0a6; font-size: 12px; font-variant-numeric: tabular-nums; min-height: 16px; }
.moon-graphs .chart { position: relative; }
.moon-graphs .chart .hd { display: flex; align-items: baseline; gap: 8px; margin-top: 4px; }
.moon-graphs .chart .sw { width: 10px; height: 3px; border-radius: 2px; align-self: center; flex: none; }
.moon-graphs .chart .name { font-weight: 600; }
.moon-graphs .chart .val { margin-left: auto; font-variant-numeric: tabular-nums; color: #bdc1c6; white-space: nowrap; }
.moon-graphs .chart .val b { color: #e8eaed; font-weight: 700; }
.moon-graphs svg { display: block; width: 100%; height: auto; overflow: visible; touch-action: none; }
.moon-graphs svg text { fill: #9aa0a6; font: 500 10px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.moon-graphs .msg { color: #9aa0a6; padding: 24px 0; text-align: center; }
.moon-graphs .msg.err { color: #f28b82; }
.moon-graphs .busy { opacity: 0.45; transition: opacity 150ms; }
/* narrow screens: along the bottom, just above the time controls (bottom / max-height set in fitAboveHud) */
@media (max-width: 900px) {
  .moon-graphs { top: auto; left: 12px; right: 12px; width: auto; bottom: 96px; max-height: 42vh; }
}
`;

const pad = (n: number) => String(n).padStart(2, '0');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtFull = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
};

/** UTC tick positions + labels for a window, ~4-7 ticks on round boundaries */
function timeTicks(t0: number, t1: number): { t: number; label: string }[] {
  const span = t1 - t0;
  const steps = [3 * H, 6 * H, 12 * H, D, 2 * D, 5 * D, 7 * D, 14 * D];
  const out: { t: number; label: string }[] = [];
  if (span > 120 * D) {
    // months (every 1, 2 or 3)
    const every = span > 300 * D ? 2 : 1;
    const d = new Date(t0);
    let y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
    for (;;) {
      if (m > 11) { y++; m -= 12; }
      const t = Date.UTC(y, m, 1);
      if (t > t1) break;
      if (m % every === 0) out.push({ t, label: m === 0 ? String(y) : MON[m] });
      m++;
    }
    return out;
  }
  const step = steps.find((s) => span / s <= 7) ?? 14 * D;
  let t = Math.ceil(t0 / step) * step;
  for (; t <= t1; t += step) {
    const d = new Date(t);
    const label = step < D
      ? (d.getUTCHours() === 0 ? `${MON[d.getUTCMonth()]} ${d.getUTCDate()}` : `${pad(d.getUTCHours())}:00`)
      : `${MON[d.getUTCMonth()]} ${d.getUTCDate()}`;
    out.push({ t, label });
  }
  return out;
}

const SVGNS = 'http://www.w3.org/2000/svg';
const NARROW = '(max-width: 900px)';

export class SiteGraphs {
  private el: HTMLDivElement;
  private whenEl: HTMLDivElement;
  private body: HTMLDivElement;
  private spanBtns: HTMLButtonElement[] = [];
  private series: SiteSeries | null = null;
  private charts: { key: Key; val: HTMLSpanElement; cursor: SVGLineElement; dot: SVGCircleElement }[] = [];
  span: Span = DEFAULT_SPAN;
  /** a timescale button was pressed (span already updated) */
  onSpanChange: (s: Span) => void = () => {};

  constructor(parent: HTMLElement) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    this.el = document.createElement('div');
    this.el.className = 'moon-graphs';
    this.el.setAttribute('role', 'region');
    this.el.setAttribute('aria-label', 'Site scores over time');
    this.el.hidden = true;

    const spans = document.createElement('div');
    spans.className = 'spans';
    spans.setAttribute('role', 'group');
    spans.setAttribute('aria-label', 'Time window');
    for (const s of SPANS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = s.label;
      b.setAttribute('aria-pressed', String(s === this.span));
      b.addEventListener('click', () => {
        if (s === this.span) return;
        this.span = s;
        for (const o of this.spanBtns) o.setAttribute('aria-pressed', String(o === b));
        this.onSpanChange(s);
      });
      this.spanBtns.push(b);
      spans.appendChild(b);
    }
    this.whenEl = document.createElement('div');
    this.whenEl.className = 'when';
    this.body = document.createElement('div');
    this.el.append(spans, this.whenEl, this.body);
    for (const ev of ['pointerdown', 'wheel', 'contextmenu'] as const) this.el.addEventListener(ev, (e) => e.stopPropagation());
    parent.appendChild(this.el);
    window.addEventListener('resize', () => this.isOpen && this.fitAboveHud());
  }

  get isOpen() {
    return !this.el.hidden;
  }

  show() {
    this.el.hidden = false;
    this.fitAboveHud();
  }

  /** narrow layout: keep the panel clear of the bottom HUD, whose height depends on the width */
  private fitAboveHud() {
    if (!matchMedia(NARROW).matches) {
      this.el.style.bottom = this.el.style.maxHeight = '';
      return;
    }
    let top = innerHeight;
    for (const c of document.querySelectorAll('.moon-hud *')) {
      const r = c.getBoundingClientRect();
      if (r.height > 0 && r.width > 0) top = Math.min(top, r.top);
    }
    const bottom = innerHeight - top + 8;
    this.el.style.bottom = `${bottom}px`;
    this.el.style.maxHeight = `${Math.max(160, Math.min(innerHeight * 0.42, top - 20))}px`;
  }

  hide() {
    this.el.hidden = true;
  }

  /** computing: keep the previous charts dimmed if there are any */
  setLoading() {
    if (this.series) this.body.classList.add('busy');
    else this.body.innerHTML = '<div class="msg">Computing scores over time...</div>';
    this.whenEl.textContent = 'Computing...';
  }

  setError() {
    this.series = null;
    this.body.classList.remove('busy');
    this.body.innerHTML = '<div class="msg err">Scores over time unavailable</div>';
    this.whenEl.textContent = '';
  }

  /** forget the charts (another site was picked) */
  clear() {
    this.series = null;
    this.body.innerHTML = '';
  }

  setSeries(s: SiteSeries) {
    this.series = s;
    this.body.classList.remove('busy');
    this.body.innerHTML = '';
    this.charts = [];
    const t0 = s.times[0], t1 = s.times[s.times.length - 1];
    const x = (t: number) => PL + ((t - t0) / Math.max(1, t1 - t0)) * PW;
    const y = (v: number) => PT + (1 - v / 100) * PH;
    const ticks = timeTicks(t0, t1);

    for (const c of CHARTS) {
      const vals = s[c.key];
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const wrap = document.createElement('div');
      wrap.className = 'chart';
      const hd = document.createElement('div');
      hd.className = 'hd';
      hd.innerHTML = `<span class="sw" style="background:${c.color}"></span><span class="name">${c.title}</span>`;
      const val = document.createElement('span');
      val.className = 'val';
      hd.appendChild(val);

      const svg = document.createElementNS(SVGNS, 'svg');
      svg.setAttribute('viewBox', `0 0 ${W} ${CH}`);
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label',
        `${c.title} score from ${fmtFull(t0)} to ${fmtFull(t1)}: now ${Math.round(vals[0])}%, average ${Math.round(mean)}%, ` +
        `min ${Math.round(Math.min(...vals))}%, max ${Math.round(Math.max(...vals))}%`);
      const parts: string[] = [];
      // recessive grid at the tier boundaries + y labels
      for (const g of GRID) {
        const gy = y(g).toFixed(1);
        parts.push(`<line x1="${PL}" x2="${W - PR}" y1="${gy}" y2="${gy}" stroke="rgba(255,255,255,${g === 0 ? 0.28 : 0.1})"` +
          `${g === 40 || g === 70 ? ' stroke-dasharray="3 3"' : ''} stroke-width="1"/>`);
        parts.push(`<text x="${PL - 6}" y="${(y(g) + 3.5).toFixed(1)}" text-anchor="end">${g}%</text>`);
      }
      for (const tk of ticks) {
        const tx = x(tk.t);
        if (tx < PL - 0.5 || tx > W - PR + 0.5) continue;
        parts.push(`<line x1="${tx.toFixed(1)}" x2="${tx.toFixed(1)}" y1="${PT + PH}" y2="${PT + PH + 3}" stroke="rgba(255,255,255,0.28)"/>`);
        const anchor = tx < PL + 14 ? 'start' : tx > W - PR - 14 ? 'end' : 'middle';
        parts.push(`<text x="${tx.toFixed(1)}" y="${CH - 4}" text-anchor="${anchor}">${tk.label}</text>`);
      }
      // the series: 2px line over a faint area
      let d = '';
      for (let i = 0; i < vals.length; i++) d += `${i ? 'L' : 'M'}${x(s.times[i]).toFixed(1)} ${y(vals[i]).toFixed(1)}`;
      const area = `${d}L${x(t1).toFixed(1)} ${y(0)}L${x(t0).toFixed(1)} ${y(0)}Z`;
      parts.push(`<path d="${area}" fill="${c.color}" fill-opacity="0.12"/>`);
      parts.push(`<path d="${d}" fill="none" stroke="${c.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
      parts.push(`<line class="cur" y1="${PT}" y2="${PT + PH}" stroke="rgba(255,255,255,0.55)" stroke-width="1" visibility="hidden"/>`);
      parts.push(`<circle class="dot" r="4" fill="${c.color}" stroke="#202124" stroke-width="2" visibility="hidden"/>`);
      // hit area over the whole plot, larger than the line
      parts.push(`<rect class="hit" x="${PL}" y="0" width="${PW}" height="${CH}" fill="transparent"/>`);
      svg.innerHTML = parts.join('');
      const cursor = svg.querySelector('.cur') as SVGLineElement;
      const dot = svg.querySelector('.dot') as SVGCircleElement;
      const hit = svg.querySelector('.hit') as SVGRectElement;
      const pick = (e: PointerEvent) => {
        const r = svg.getBoundingClientRect();
        const ux = ((e.clientX - r.left) / r.width) * W;
        const f = Math.max(0, Math.min(1, (ux - PL) / PW));
        this.hover(Math.round(f * (vals.length - 1)));
      };
      hit.addEventListener('pointermove', pick);
      hit.addEventListener('pointerdown', pick);
      hit.addEventListener('pointerleave', () => this.hover(null));

      wrap.append(hd, svg);
      this.body.appendChild(wrap);
      this.charts.push({ key: c.key, val, cursor, dot });
    }
    this.hover(null);
  }

  /** show the values at sample i on every chart (null: the summary for the window) */
  private hover(i: number | null) {
    const s = this.series;
    if (!s) return;
    const t0 = s.times[0], t1 = s.times[s.times.length - 1];
    if (i === null) this.whenEl.textContent = `${fmtFull(t0)} → ${fmtFull(t1)}`;
    else this.whenEl.textContent = fmtFull(s.times[i]);
    for (const c of this.charts) {
      const vals = s[c.key];
      if (i === null) {
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        c.val.innerHTML = `now <b>${Math.round(vals[0])}%</b> · avg <b>${Math.round(mean)}%</b>`;
        c.cursor.setAttribute('visibility', 'hidden');
        c.dot.setAttribute('visibility', 'hidden');
      } else {
        const px = PL + ((s.times[i] - t0) / Math.max(1, t1 - t0)) * PW;
        const py = PT + (1 - vals[i] / 100) * PH;
        c.val.innerHTML = `<b>${Math.round(vals[i])}%</b>`;
        c.cursor.setAttribute('x1', px.toFixed(1));
        c.cursor.setAttribute('x2', px.toFixed(1));
        c.cursor.setAttribute('visibility', 'visible');
        c.dot.setAttribute('cx', px.toFixed(1));
        c.dot.setAttribute('cy', py.toFixed(1));
        c.dot.setAttribute('visibility', 'visible');
      }
    }
  }
}
