// Right-click site inspector: a dismissible hint at the top of the screen, and a popup
// anchored to the picked surface point (coordinates, colour-coded feasibility score,
// "More info" / "Enter VR" actions). Plain DOM, styled like the bottom HUD.

const CSS = `
.moon-hint {
  position: fixed; top: max(16px, env(safe-area-inset-top)); left: 50%; transform: translateX(-50%);
  z-index: 3; max-width: calc(100vw - 32px); box-sizing: border-box;
  display: flex; align-items: center; gap: 14px; padding: 8px 16px;
  background: rgba(32, 33, 36, 0.86); border-radius: 12px; box-shadow: 0 1px 4px rgba(0,0,0,0.6);
  font: 500 14px/1.3 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #e8eaed;
  user-select: none; -webkit-user-select: none;
  transition: opacity 180ms ease, transform 180ms ease;
}
.moon-hint.hidden { opacity: 0; transform: translate(-50%, -8px); pointer-events: none; }
.moon-hint button { all: unset; cursor: pointer; color: #8ab4f8; text-decoration: underline;
  text-underline-offset: 3px; font-weight: 600; white-space: nowrap; border-radius: 4px; }
.moon-hint button:hover { color: #aecbfa; }
.moon-hint button:focus-visible { outline: 2px solid #8ab4f8; outline-offset: 2px; }

.moon-pin { position: fixed; left: 0; top: 0; z-index: 2; width: 10px; height: 10px; margin: -5px 0 0 -5px;
  border-radius: 50%; background: #f28b82; box-shadow: 0 0 0 2px rgba(0,0,0,0.55), 0 0 8px rgba(242,139,130,0.8);
  pointer-events: none; }

.moon-site {
  position: fixed; left: 0; top: 0; z-index: 3; box-sizing: border-box;
  width: max-content; max-width: min(340px, calc(100vw - 32px));
  padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 10px;
  background: rgba(32, 33, 36, 0.92); border-radius: 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.6);
  font: 500 14px/1.3 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #e8eaed;
  animation: moon-site-in 160ms ease-out;
}
.moon-site[hidden], .moon-pin[hidden] { display: none; }
@keyframes moon-site-in { from { opacity: 0; translate: 0 6px; } to { opacity: 1; translate: 0 0; } }
/* tail pointing down at the pin */
.moon-site::after { content: ""; position: absolute; left: var(--tail, 50%); bottom: -7px; width: 14px; height: 14px;
  background: inherit; transform: translateX(-50%) rotate(45deg); border-radius: 0 0 3px 0; }
.moon-site .close { all: unset; position: absolute; top: 6px; right: 6px; width: 24px; height: 24px;
  display: grid; place-items: center; border-radius: 6px; cursor: pointer; color: #9aa0a6; font-size: 18px; line-height: 1; }
.moon-site .close:hover { color: #fff; background: rgba(255,255,255,0.08); }
.moon-site .close:focus-visible { outline: 2px solid #8ab4f8; }
.moon-site .coords { padding-right: 22px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.moon-site .coords .k { color: #9aa0a6; margin-right: 6px; }

.moon-site .feas { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 8px;
  border: 1px solid #5f6368; background: rgba(95, 99, 104, 0.18); white-space: nowrap; }
.moon-site .feas .val { margin-left: auto; font-weight: 700; font-size: 16px; font-variant-numeric: tabular-nums; }
.moon-site .feas .tier { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
  padding: 2px 6px; border-radius: 4px; }
.moon-site .feas.good { border-color: #21b245; background: rgba(33, 178, 69, 0.16); }
.moon-site .feas.good .val { color: #5bd77a; }
.moon-site .feas.good .tier { background: #21b245; color: #08210f; }
.moon-site .feas.fair { border-color: #fad629; background: rgba(250, 214, 41, 0.14); }
.moon-site .feas.fair .val { color: #fde26a; }
.moon-site .feas.fair .tier { background: #fad629; color: #2a2200; }
.moon-site .feas.poor { border-color: #db1f17; background: rgba(219, 31, 23, 0.18); }
.moon-site .feas.poor .val { color: #f28b82; }
.moon-site .feas.poor .tier { background: #db1f17; color: #fff; }
.moon-site .feas .spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid #9aa0a6; border-top-color: transparent;
  animation: moon-spin 0.8s linear infinite; margin-left: auto; }
@keyframes moon-spin { to { transform: rotate(360deg); } }

.moon-site .btns { display: flex; gap: 10px; }
/* same look as the surface walk's light button (walk.ts: "Enter headset") */
.moon-site .btns button { all: unset; flex: 1; box-sizing: border-box; text-align: center; cursor: pointer;
  padding: 7px 11px; border-radius: 7px; border: 1px solid #eceef0; background: #eceef0; color: #101113;
  white-space: nowrap; }
.moon-site .btns button:hover { background: #ffffff; border-color: #ffffff; }
.moon-site .btns button:active { background: #d4d7db; border-color: #d4d7db; }
.moon-site .btns button:focus-visible { outline: 2px solid #8ab4f8; outline-offset: 2px; }
`;

export type Tier = 'good' | 'fair' | 'poor';
/** score (0-100 %) -> colour tier: green >= 70, yellow >= 40, red below */
export const scoreTier = (s: number): Tier => (s >= 70 ? 'good' : s >= 40 ? 'fair' : 'poor');
const TIER_LABEL: Record<Tier, string> = { good: 'Good', fair: 'Fair', poor: 'Poor' };

const fmtDeg = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(3)}°`;

/** "Right click a spot to get more info  Got it" banner at the top of the screen.
 *  Returns a function that dismisses it (also called by "Got it"); safe to call repeatedly. */
export function createHint(parent: HTMLElement): () => void {
  const el = document.createElement('div');
  el.className = 'moon-hint';
  el.setAttribute('role', 'status');
  el.innerHTML = '<span>Right click a spot to get more info</span><button type="button">Got it</button>';
  let gone = false;
  const dismiss = () => {
    if (gone) return;
    gone = true;
    el.classList.add('hidden');
    setTimeout(() => el.remove(), 250);
  };
  (el.querySelector('button') as HTMLButtonElement).addEventListener('click', dismiss);
  for (const ev of ['pointerdown', 'wheel', 'contextmenu'] as const) el.addEventListener(ev, (e) => e.stopPropagation());
  parent.appendChild(el);
  return dismiss;
}

export class SitePopup {
  private el: HTMLDivElement;
  private pin: HTMLDivElement;
  private coords: HTMLSpanElement;
  private feas: HTMLDivElement;
  private open = false;
  /** called when the popup is closed by the user */
  onClose: () => void = () => {};
  /** called when "More info" is clicked */
  onMoreInfo: () => void = () => {};
  /** called when "Enter VR" is clicked: land at this site and open the surface walk */
  onEnterVR: () => void = () => {};

  constructor(parent: HTMLElement) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    this.pin = document.createElement('div');
    this.pin.className = 'moon-pin';
    this.pin.hidden = true;

    const el = document.createElement('div');
    el.className = 'moon-site';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Site info');
    el.hidden = true;
    el.innerHTML = `
      <button type="button" class="close" aria-label="Close">×</button>
      <div class="coords"><span class="k">Coordinates:</span><span class="v"></span></div>
      <div class="feas"></div>
      <div class="btns"><button type="button" data-act="info">More info</button><button type="button" data-act="vr">Enter VR</button></div>`;
    this.coords = el.querySelector('.coords .v') as HTMLSpanElement;
    this.feas = el.querySelector('.feas') as HTMLDivElement;
    (el.querySelector('.close') as HTMLButtonElement).addEventListener('click', () => this.close());
    (el.querySelector('[data-act="info"]') as HTMLButtonElement).addEventListener('click', () => this.onMoreInfo());
    (el.querySelector('[data-act="vr"]') as HTMLButtonElement).addEventListener('click', () => this.onEnterVR());
    for (const ev of ['pointerdown', 'wheel', 'contextmenu'] as const) el.addEventListener(ev, (e) => e.stopPropagation());
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.open) this.close();
    });
    parent.append(this.pin, el);
    this.el = el;
  }

  show(lat: number, lon: number) {
    const lonW = ((((lon + 180) % 360) + 360) % 360) - 180;
    this.coords.textContent = `${fmtDeg(lat)}, ${fmtDeg(lonW)}`;
    this.coords.title = `latitude ${lat.toFixed(5)}°, longitude ${lonW.toFixed(5)}° E`;
    this.setLoading();
    this.open = true;
    // restart the entry animation
    this.el.hidden = true;
    void this.el.offsetWidth;
  }

  setLoading() {
    this.feas.className = 'feas';
    this.feas.innerHTML = '<span>Feasibility score:</span><span class="spin" aria-label="computing"></span>';
  }

  setScore(score: number | null) {
    if (score === null || !Number.isFinite(score)) {
      this.feas.className = 'feas';
      this.feas.innerHTML = '<span>Feasibility score:</span><span class="val">n/a</span>';
      return;
    }
    const t = scoreTier(score);
    this.feas.className = `feas ${t}`;
    this.feas.innerHTML = `<span>Feasibility score:</span><span class="val">${Math.round(score)}%</span><span class="tier">${TIER_LABEL[t]}</span>`;
  }

  /** place the popup above a screen point (CSS px); null hides it (point behind / off screen) */
  place(p: { x: number; y: number } | null) {
    if (!this.open || !p) {
      this.el.hidden = true;
      this.pin.hidden = true;
      return;
    }
    this.el.hidden = false;
    this.pin.hidden = false;
    this.pin.style.transform = `translate(${p.x}px, ${p.y}px)`;
    const w = this.el.offsetWidth, h = this.el.offsetHeight;
    const margin = 16;
    const x = Math.min(window.innerWidth - margin - w, Math.max(margin, p.x - w / 2));
    const y = p.y - h - 14;
    this.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    // keep the tail over the pin when the box is pushed in from a screen edge
    this.el.style.setProperty('--tail', `${p.x - x}px`);
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.el.hidden = true;
    this.pin.hidden = true;
    this.onClose();
  }
}
