// Bottom bar: metric scale bar (left), UTC date/time spinner (centre), compass slot (right).
// Plain DOM; every update writes to the DOM only when the shown value changes.

type FieldKey = 'day' | 'month' | 'year' | 'hour' | 'minute';

const CSS = `
.moon-hud {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 2;
  padding: 0 16px max(16px, env(safe-area-inset-bottom));
  display: grid; grid-template-columns: 1fr auto 1fr; align-items: end; gap: 12px;
  pointer-events: none;
  font: 500 15px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: #e8eaed; user-select: none; -webkit-user-select: none;
}
.moon-hud > * { pointer-events: auto; }
.moon-hud .slot-right { justify-self: end; }

/* scale bar */
.moon-scale { justify-self: start; display: flex; flex-direction: column; align-items: flex-start; gap: 3px;
  pointer-events: none; filter: drop-shadow(0 1px 1.5px rgba(0,0,0,0.9)); }
.moon-scale .bar { height: 7px; border: 2px solid #fff; border-top: 0; box-sizing: border-box;
  transition: width 120ms ease; }
.moon-scale .label { font-size: 13px; font-variant-numeric: tabular-nums; letter-spacing: 0.01em;
  text-shadow: 0 1px 2px #000, 0 0 4px #000; }

/* centre group: date/time box + feasibility toggle */
.moon-centre { display: flex; align-items: stretch; gap: 10px; }
.moon-feas { all: unset; box-sizing: border-box; display: flex; flex-direction: column; justify-content: center; gap: 4px;
  padding: 6px 12px; background: rgba(32, 33, 36, 0.86); border-radius: 12px; box-shadow: 0 1px 4px rgba(0,0,0,0.6);
  cursor: pointer; color: #e8eaed; -webkit-tap-highlight-color: transparent; }
.moon-feas:hover { background: rgba(60, 64, 67, 0.92); }
.moon-feas:focus-visible { outline: 2px solid #8ab4f8; outline-offset: 2px; }
.moon-feas .lbl { font-size: 12px; font-weight: 500; letter-spacing: 0.01em; white-space: nowrap; }
.moon-feas .row { display: flex; align-items: center; gap: 8px; }
.moon-feas .sw { position: relative; width: 34px; height: 18px; border-radius: 9px; background: #5f6368; transition: background-color 150ms ease; flex: none; }
.moon-feas .sw::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%;
  background: #f1f3f4; box-shadow: 0 1px 2px rgba(0,0,0,0.5); transition: transform 150ms ease; }
.moon-feas[aria-checked="true"] .sw { background: linear-gradient(90deg, #db1f17, #fad629 55%, #21b245); }
.moon-feas[aria-checked="true"] .sw::after { transform: translateX(16px); }
.moon-feas .state { font-size: 13px; font-weight: 600; min-width: 26px; }

/* date / time */
.moon-time { display: flex; align-items: center; gap: 2px; padding: 4px 12px;
  background: rgba(32, 33, 36, 0.86); border-radius: 12px; box-shadow: 0 1px 4px rgba(0,0,0,0.6);
  font-variant-numeric: tabular-nums; }
.moon-time .field { display: flex; flex-direction: column; align-items: center; }
.moon-time .val { padding: 1px 3px; border-radius: 5px; outline: none; cursor: ns-resize; font-size: 17px; }
.moon-time .val:hover { background: rgba(255,255,255,0.08); }
.moon-time .val:focus-visible { background: rgba(138,180,248,0.22); box-shadow: 0 0 0 1px #8ab4f8; }
.moon-time .sep { opacity: 0.6; font-size: 17px; padding: 0 1px; }
.moon-time .gap { width: 10px; }
.moon-time .tz { font-size: 11px; opacity: 0.6; margin-left: 6px; align-self: center; letter-spacing: 0.04em; }
.moon-time button { all: unset; display: grid; place-items: center; width: 100%; min-width: 24px; height: 16px;
  cursor: pointer; border-radius: 4px; color: #9aa0a6; -webkit-tap-highlight-color: transparent; }
.moon-time button:hover { color: #fff; background: rgba(255,255,255,0.08); }
.moon-time button:active { color: #8ab4f8; }
.moon-time button:focus-visible { outline: 1px solid #8ab4f8; }
.moon-time button svg { width: 10px; height: 6px; display: block; }

@media (pointer: coarse) { .moon-time button { height: 22px; min-width: 30px; } }
@media (max-width: 560px) {
  .moon-hud { grid-template-columns: 1fr 1fr; grid-template-areas: "time time" "scale right"; row-gap: 10px; }
  .moon-hud .moon-centre { grid-area: time; justify-self: center; flex-wrap: wrap; justify-content: center; }
  .moon-hud .moon-scale { grid-area: scale; }
  .moon-hud .slot-right { grid-area: right; }
}
`;

function tri(up: boolean): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 10 6');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', up ? 'M5 0 L10 6 L0 6 Z' : 'M0 0 L10 0 L5 6 Z');
  p.setAttribute('fill', 'currentColor');
  svg.appendChild(p);
  return svg;
}

const pad = (v: number, n = 2) => String(v).padStart(n, '0');

/** add `delta` units of `key` to a UTC timestamp; months/years clamp the day */
export function stepTime(ms: number, key: FieldKey, delta: number): number {
  const d = new Date(ms);
  switch (key) {
    case 'minute': return ms + delta * 60000;
    case 'hour': return ms + delta * 3600000;
    case 'day': return ms + delta * 86400000;
    case 'month':
    case 'year': {
      let y = d.getUTCFullYear(), m = d.getUTCMonth();
      if (key === 'month') { m += delta; y += Math.floor(m / 12); m = ((m % 12) + 12) % 12; } else y += delta;
      const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      return Date.UTC(y, m, Math.min(d.getUTCDate(), dim), d.getUTCHours(), d.getUTCMinutes());
    }
  }
}

export class Hud {
  readonly root: HTMLDivElement;
  readonly rightSlot: HTMLDivElement;
  private scaleBar: HTMLDivElement;
  private scaleLabel: HTMLDivElement;
  private vals = new Map<FieldKey, HTMLSpanElement>();
  private lastScale = '';
  private lastPx = -1;
  private t = 0;
  private feasBtn!: HTMLButtonElement;
  /** called when the user toggles the feasibility overlay */
  onFeasibility: (on: boolean) => void = () => {};

  constructor(
    parent: HTMLElement,
    private range: [number, number],
    private onTime: (ms: number) => void,
  ) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.className = 'moon-hud';

    // scale
    const scale = document.createElement('div');
    scale.className = 'moon-scale';
    scale.setAttribute('aria-hidden', 'true');
    this.scaleBar = document.createElement('div');
    this.scaleBar.className = 'bar';
    this.scaleLabel = document.createElement('div');
    this.scaleLabel.className = 'label';
    scale.append(this.scaleBar, this.scaleLabel);

    // date / time, date order from the user's locale, 24 h clock, UTC
    const time = document.createElement('div');
    time.className = 'moon-time';
    time.setAttribute('role', 'group');
    time.setAttribute('aria-label', 'Date and time (UTC)');
    const parts = new Intl.DateTimeFormat(undefined, { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' })
      .formatToParts(new Date(Date.UTC(2026, 7, 2)));
    const order: (FieldKey | string)[] = [];
    for (const p of parts) {
      if (p.type === 'day' || p.type === 'month' || p.type === 'year') order.push(p.type);
      else if (p.type === 'literal' && order.length && order.length < 5) order.push('sep:' + (p.value.trim() || '/'));
    }
    while (order.length && order[order.length - 1].startsWith('sep:')) order.pop();
    order.push('gap', 'hour', 'sep::', 'minute');
    const labels: Record<FieldKey, string> = { day: 'Day', month: 'Month', year: 'Year', hour: 'Hour (UTC)', minute: 'Minute' };
    for (const k of order) {
      if (k === 'gap') {
        const g = document.createElement('span');
        g.className = 'gap';
        time.appendChild(g);
      } else if (k.startsWith('sep:')) {
        const s = document.createElement('span');
        s.className = 'sep';
        s.textContent = k.slice(4);
        time.appendChild(s);
      } else time.appendChild(this.field(k as FieldKey, labels[k as FieldKey]));
    }
    const tz = document.createElement('span');
    tz.className = 'tz';
    tz.textContent = 'UTC';
    time.appendChild(tz);

    this.rightSlot = document.createElement('div');
    this.rightSlot.className = 'slot-right';

    // feasibility overlay toggle (right of the time box)
    const feas = document.createElement('button');
    feas.type = 'button';
    feas.className = 'moon-feas';
    feas.setAttribute('role', 'switch');
    feas.setAttribute('aria-checked', 'false');
    feas.title = 'Feasibility heatmap: red 0 % -> yellow 50 % -> green 100 %';
    feas.innerHTML = '<span class="lbl">Feasibility Overlay:</span><span class="row"><span class="sw"></span><span class="state">OFF</span></span>';
    feas.addEventListener('click', () => this.setFeasibility(feas.getAttribute('aria-checked') !== 'true', true));
    this.feasBtn = feas;
    const centre = document.createElement('div');
    centre.className = 'moon-centre';
    centre.append(time, feas);

    root.append(scale, centre, this.rightSlot);
    parent.appendChild(root);
    this.root = root;
    // keep pointer/wheel interaction on the bar from reaching the globe controls
    for (const ev of ['pointerdown', 'wheel', 'contextmenu'] as const) {
      time.addEventListener(ev, (e) => e.stopPropagation());
      feas.addEventListener(ev, (e) => e.stopPropagation());
    }
  }

  private field(key: FieldKey, label: string): HTMLDivElement {
    const f = document.createElement('div');
    f.className = 'field';
    const up = document.createElement('button');
    up.type = 'button';
    up.setAttribute('aria-label', `${label} up`);
    up.tabIndex = -1;
    up.appendChild(tri(true));
    const dn = document.createElement('button');
    dn.type = 'button';
    dn.setAttribute('aria-label', `${label} down`);
    dn.tabIndex = -1;
    dn.appendChild(tri(false));
    const v = document.createElement('span');
    v.className = 'val';
    v.tabIndex = 0;
    v.setAttribute('role', 'spinbutton');
    v.setAttribute('aria-label', label);
    this.vals.set(key, v);
    this.autoRepeat(up, () => this.step(key, +1));
    this.autoRepeat(dn, () => this.step(key, -1));
    v.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : e.key === 'PageUp' ? 10 : e.key === 'PageDown' ? -10 : 0;
      if (d) {
        e.preventDefault();
        this.step(key, d);
      }
    });
    v.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.step(key, e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
    f.append(up, v, dn);
    return f;
  }

  /** press = one step; hold = repeat, accelerating */
  private autoRepeat(btn: HTMLButtonElement, fn: () => void) {
    let timer = 0;
    const stop = () => clearTimeout(timer);
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      btn.setPointerCapture(e.pointerId);
      fn();
      let delay = 380;
      const tick = () => {
        fn();
        delay = Math.max(35, delay * 0.82);
        timer = window.setTimeout(tick, delay);
      };
      timer = window.setTimeout(tick, delay);
    });
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointercancel', stop);
    btn.addEventListener('lostpointercapture', stop);
    btn.addEventListener('click', (e) => {
      if (e.detail === 0) fn(); // keyboard activation
    });
  }

  private step(key: FieldKey, delta: number) {
    const ms = Math.min(this.range[1], Math.max(this.range[0], stepTime(this.t, key, delta)));
    if (ms === this.t) return;
    this.setTime(ms);
    this.onTime(ms);
  }

  setTime(ms: number) {
    this.t = ms;
    const d = new Date(ms);
    const v: Record<FieldKey, string> = {
      day: pad(d.getUTCDate()), month: pad(d.getUTCMonth() + 1), year: String(d.getUTCFullYear()),
      hour: pad(d.getUTCHours()), minute: pad(d.getUTCMinutes()),
    };
    for (const [k, el] of this.vals) {
      if (el.textContent !== v[k]) el.textContent = v[k];
      el.setAttribute('aria-valuenow', v[k]);
    }
  }

  setFeasibility(on: boolean, notify = false) {
    this.feasBtn.setAttribute('aria-checked', String(on));
    (this.feasBtn.querySelector('.state') as HTMLElement).textContent = on ? 'ON' : 'OFF';
    if (notify) this.onFeasibility(on);
  }

  /** metres per CSS pixel at the view centre */
  setScale(metresPerPx: number) {
    if (!isFinite(metresPerPx) || metresPerPx <= 0) return;
    // largest 1/2/5 x 10^k length that fits in ~120 px
    const target = metresPerPx * 120;
    const p = Math.pow(10, Math.floor(Math.log10(target)));
    const nice = [5, 2, 1].map((k) => k * p).find((v) => v <= target) ?? p;
    const px = Math.round(nice / metresPerPx);
    const label = nice >= 1000 ? `${(nice / 1000).toLocaleString()} km` : `${nice.toLocaleString()} m`;
    if (px !== this.lastPx) {
      this.scaleBar.style.width = `${px}px`;
      this.lastPx = px;
    }
    if (label !== this.lastScale) {
      this.scaleLabel.textContent = label;
      this.lastScale = label;
    }
  }
}
