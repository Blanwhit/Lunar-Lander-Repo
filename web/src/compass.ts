// Google-Earth-style compass: a dark round button with a red (north) / white (south)
// needle that always points to lunar north on screen. Clicking it turns the view back
// to north-up. Pure DOM + inline SVG; updated only when the heading actually changes.

const SVG_NS = 'http://www.w3.org/2000/svg';

export class Compass {
  readonly el: HTMLButtonElement;
  private needle: SVGGElement;
  private lastDeg = NaN;

  constructor(parent: HTMLElement, onClick: () => void) {
    const style = document.createElement('style');
    style.textContent = `
      .moon-compass {
        position: fixed; right: 16px; bottom: 16px; z-index: 2;
        width: 44px; height: 44px; padding: 0; border: 0; border-radius: 50%;
        background: rgba(32, 33, 36, 0.86);
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.6);
        cursor: pointer; display: grid; place-items: center;
        -webkit-tap-highlight-color: transparent; touch-action: manipulation;
        transition: background-color 120ms ease, transform 120ms ease;
      }
      .moon-compass:hover { background: rgba(60, 64, 67, 0.92); }
      .moon-compass:active { transform: scale(0.94); }
      .moon-compass:focus-visible { outline: 2px solid #8ab4f8; outline-offset: 2px; }
      .moon-compass svg { width: 30px; height: 30px; display: block; overflow: visible; }
      @media (pointer: coarse) { .moon-compass { width: 48px; height: 48px; } }
    `;
    document.head.appendChild(style);

    const btn = document.createElement('button');
    btn.className = 'moon-compass';
    btn.type = 'button';
    btn.title = 'Reset to north';
    btn.setAttribute('aria-label', 'Compass: reset view to north');

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '-15 -15 30 30');
    svg.setAttribute('aria-hidden', 'true');
    const g = document.createElementNS(SVG_NS, 'g');
    // needle: two slim triangles meeting at the centre; north half red, south half white
    const north = document.createElementNS(SVG_NS, 'path');
    north.setAttribute('d', 'M0 -13 L5 0 L-5 0 Z');
    north.setAttribute('fill', '#ea4335');
    const northShade = document.createElementNS(SVG_NS, 'path'); // right half slightly darker
    northShade.setAttribute('d', 'M0 -13 L5 0 L0 0 Z');
    northShade.setAttribute('fill', '#c5221f');
    const south = document.createElementNS(SVG_NS, 'path');
    south.setAttribute('d', 'M0 13 L5 0 L-5 0 Z');
    south.setAttribute('fill', '#f1f3f4');
    const southShade = document.createElementNS(SVG_NS, 'path');
    southShade.setAttribute('d', 'M0 13 L5 0 L0 0 Z');
    southShade.setAttribute('fill', '#c4c7c5');
    g.append(north, northShade, south, southShade);
    svg.appendChild(g);
    btn.appendChild(svg);

    // keep pointer/wheel interaction on the button from reaching the globe controls
    for (const ev of ['pointerdown', 'wheel', 'contextmenu'] as const)
      btn.addEventListener(ev, (e) => e.stopPropagation());
    btn.addEventListener('click', onClick);

    parent.appendChild(btn);
    this.el = btn;
    this.needle = g;
  }

  /** @param headingRad compass bearing of the screen-up direction (0 = north, +east) */
  update(headingRad: number) {
    // north appears rotated counter-clockwise by the heading
    const deg = Math.round((-headingRad * 180) / Math.PI * 10) / 10;
    if (deg === this.lastDeg) return;
    this.lastDeg = deg;
    this.needle.setAttribute('transform', `rotate(${deg})`);
  }
}
