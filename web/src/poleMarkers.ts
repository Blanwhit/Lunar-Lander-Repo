// Rotation-axis markers for the desktop globe: an "N" label above the north pole and an "S"
// label below the south pole, each joined to the pole's surface by a straight line (red for
// north, white for south). Deliberately simple: a 2D SVG overlay, no depth buffer. What the
// Moon hides is worked out analytically instead: each line stops at the surface, and when
// the pole is on the far side only the part rising above the limb is drawn (a sphere through
// the pole stands in for the Moon). Only shown by the desktop globe view (main.ts), never in
// the landing flight, the walk or VR.
import { Vector3, Vector4 } from 'three';
import type { Matrix3, Matrix4 } from 'three';
import { R_MOON } from './geom';

/** labels sit on the body z axis (ME/PA frame: +z = north pole) at this radius */
const R_LABEL = R_MOON * 1.3;

const CSS = `
.moon-poles { position: fixed; inset: 0; width: 100%; height: 100%; z-index: 1; pointer-events: none; overflow: hidden; }
.moon-poles text { font: 700 15px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  paint-order: stroke; stroke: #000; stroke-width: 3px; stroke-linejoin: round; }
`;

const SVGNS = 'http://www.w3.org/2000/svg';

interface Pole {
  sign: 1 | -1;
  line: SVGLineElement;
  text: SVGTextElement;
}

export class PoleMarkers {
  private svg: SVGSVGElement;
  private poles: Pole[];

  constructor(parent: HTMLElement) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    this.svg = document.createElementNS(SVGNS, 'svg');
    this.svg.classList.add('moon-poles');
    this.svg.setAttribute('aria-hidden', 'true');
    this.svg.style.display = 'none';
    this.poles = ([[1, 'N', '#ff3b3b'], [-1, 'S', '#ffffff']] as const).map(([sign, label, color]) => {
      const line = document.createElementNS(SVGNS, 'line');
      line.setAttribute('stroke', color);
      line.setAttribute('stroke-width', '1.5');
      const text = document.createElementNS(SVGNS, 'text');
      text.textContent = label;
      text.setAttribute('fill', color);
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dominant-baseline', 'central');
      this.svg.append(line, text);
      return { sign, line, text };
    });
    parent.appendChild(this.svg);
  }

  /** redraw for the current view; cssW / cssH: canvas size in CSS px */
  /** poleHeight(sign): terrain height (m vs the reference sphere) at the north (1) / south (-1) pole */
  update(camPos: readonly number[], viewRot: Matrix3, proj: Matrix4, cssW: number, cssH: number,
    poleHeight: (sign: 1 | -1) => number) {
    this.svg.style.display = '';
    const cam = new Vector3(camPos[0], camPos[1], camPos[2]);
    const toView = (p: Vector3) => p.clone().sub(cam).applyMatrix3(viewRot);
    // keep everything in front of the camera (view space looks down -z)
    const NEAR = -1;
    const toScreen = (v: Vector3) => {
      const c = new Vector4(v.x, v.y, v.z, 1).applyMatrix4(proj);
      return { x: (c.x / c.w + 1) * 0.5 * cssW, y: (1 - c.y / c.w) * 0.5 * cssH };
    };
    for (const p of this.poles) {
      const rSurf = R_MOON + poleHeight(p.sign);
      const tipW = new Vector3(0, 0, p.sign * R_LABEL);
      // the visible stretch [rFrom, R_LABEL] of the axis: from the surface, or from where it
      // clears the limb (along an outward radial the hidden part is one stretch from the ground)
      const hidden = (r: number) => blockedBy(cam, new Vector3(0, 0, p.sign * r), rSurf - 1);
      let rFrom = rSurf;
      const tipHidden = hidden(R_LABEL);
      if (!tipHidden && hidden(rSurf)) {
        let lo = rSurf, hi = R_LABEL;
        for (let k = 0; k < 30; k++) {
          const mid = (lo + hi) / 2;
          if (hidden(mid)) lo = mid;
          else hi = mid;
        }
        rFrom = hi;
      }
      const tip = toView(tipW);
      const centre = toView(new Vector3(0, 0, p.sign * rFrom));
      if (tipHidden) {
        p.text.style.display = 'none';
        p.line.style.display = 'none';
        continue;
      }
      // the label: only when its point is in front of the camera
      const labelShown = tip.z < NEAR;
      p.text.style.display = labelShown ? '' : 'none';
      if (labelShown) {
        const s = toScreen(tip);
        p.text.setAttribute('x', s.x.toFixed(1));
        p.text.setAttribute('y', s.y.toFixed(1));
      }
      // the line, cut where it passes behind the camera
      let a = tip, b = centre;
      if (a.z >= NEAR && b.z >= NEAR) {
        p.line.style.display = 'none';
        continue;
      }
      if (a.z >= NEAR) a = a.clone().lerp(b, (a.z - NEAR) / (a.z - b.z));
      else if (b.z >= NEAR) b = b.clone().lerp(a, (b.z - NEAR) / (b.z - a.z));
      // stop the line just short of the letter so it doesn't run through it
      const sa = toScreen(a), sb = toScreen(b);
      if (labelShown) {
        const dx = sb.x - sa.x, dy = sb.y - sa.y, len = Math.hypot(dx, dy);
        if (len > 12) {
          sa.x += (dx / len) * 11;
          sa.y += (dy / len) * 11;
        }
      }
      // trim to the screen: near the ground the far end can project millions of px away
      const seg = clipToRect(sa.x, sa.y, sb.x, sb.y, -20, -20, cssW + 20, cssH + 20);
      if (!seg) {
        p.line.style.display = 'none';
        continue;
      }
      p.line.style.display = '';
      p.line.setAttribute('x1', seg[0].toFixed(1));
      p.line.setAttribute('y1', seg[1].toFixed(1));
      p.line.setAttribute('x2', seg[2].toFixed(1));
      p.line.setAttribute('y2', seg[3].toFixed(1));
    }
  }

  hide() {
    this.svg.style.display = 'none';
  }
}

/** does a sphere of radius r (at the Moon's centre) block the view from cam to p? */
function blockedBy(cam: Vector3, p: Vector3, r: number): boolean {
  const d = p.clone().sub(cam);
  const len = d.length();
  if (len === 0) return false;
  d.divideScalar(len);
  const b = cam.dot(d);
  const disc = b * b - (cam.lengthSq() - r * r);
  if (disc <= 0) return false;
  const t = -b - Math.sqrt(disc); // first crossing along the sight line
  return t > 0 && t < len;
}

/** Liang-Barsky: the part of segment (x0,y0)-(x1,y1) inside the rectangle, or null */
function clipToRect(x0: number, y0: number, x1: number, y1: number,
  minX: number, minY: number, maxX: number, maxY: number): [number, number, number, number] | null {
  const dx = x1 - x0, dy = y1 - y0;
  let t0 = 0, t1 = 1;
  const edges: [number, number][] = [[-dx, x0 - minX], [dx, maxX - x0], [-dy, y0 - minY], [dy, maxY - y0]];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null; // parallel to this edge and outside it
      continue;
    }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r);
    else t1 = Math.min(t1, r);
    if (t0 > t1) return null;
  }
  return [x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy];
}
