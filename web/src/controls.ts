import { Matrix3, Matrix4, Quaternion, Vector3 } from 'three';
import { latLonToDir, R_MOON, Vec3 } from './geom';

// Globe controls in the lunar body frame.
// The camera orbits a pivot on the surface (target direction `tgt`) at distance `dist`,
// looking at it with tilt tau (0 = straight down). `fwd` is the screen-up tangent at
// the target; it is parallel-transported when the target moves, so there is no
// singularity at the poles.

const DEG = Math.PI / 180;

export interface ControlsState {
  camPos: Vec3;
  viewRot: Matrix3; // body -> view
  pivot: Vec3;
}

export class GlobeControls {
  tgt = new Vector3(1, 0, 0);
  fwd = new Vector3(0, 0, 1);
  dist = 8e6;
  logDistGoal = Math.log(8e6);
  tiltUser = 0;
  tiltGoal = 0;
  minDist = 60;
  private zoomVelocity = 0;
  private turn?: { from: Quaternion; to: Quaternion; elapsed: number };
  maxDist = 8e6;
  minClearance = 15; // m above terrain
  pivotHeight = 0;
  fovY = 45 * DEG;
  private omega = new Vector3(); // angular velocity (rad/s) about axis
  private headingVel = 0;
  private northing = false; // animating back to north-up (compass click)
  private flyGoal: Vector3 | null = null; // smooth pan of the target to this direction
  private dragging = false;
  private lastMove = 0;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch: { d: number; ang: number } | null = null;
  private mode: 'pan' | 'rotate' = 'pan';
  private q = new Quaternion();
  private tmp = new Vector3();
  changed = true;

  constructor(private el: HTMLElement, private heightAt: (d: Vec3) => number | null) {
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointercancel', this.onUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  setView(latDeg: number, lonDeg: number, dist: number, headingDeg = 0, tiltDeg?: number) {
    this.turn = undefined;
    const la = latDeg * DEG, lo = lonDeg * DEG;
    this.tgt.set(Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la));
    const { east, north } = this.frameAt(this.tgt);
    this.fwd.copy(north).multiplyScalar(Math.cos(headingDeg * DEG)).addScaledVector(east, Math.sin(headingDeg * DEG));
    this.dist = Math.min(this.maxDist, Math.max(this.minDist, dist));
    this.logDistGoal = Math.log(this.dist);
    this.zoomVelocity = 0;
    if (tiltDeg !== undefined) this.tiltUser = this.tiltGoal = tiltDeg * DEG - this.autoTilt(this.dist);
    this.northing = false;
    this.flyGoal = null;
    this.omega.set(0, 0, 0);
    this.headingVel = 0;
    this.changed = true;
  }

  orientation() {
    const right = this.fwd.clone().cross(this.tgt).normalize();
    return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(right, this.tgt, this.fwd.clone().negate()));
  }

  faceLocation(lat: number, lon: number) {
    const up = new Vector3(...latLonToDir(lat,lon));
    const east = new Vector3(-Math.sin(lon*DEG), Math.cos(lon*DEG), 0);
    const to = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(east, up, east.clone().cross(up)));
    this.turn = { from: this.orientation(), to, elapsed: 0 };
    this.omega.set(0,0,0);
    this.headingVel = 0;
    this.northing = false;
  }

  private frameAt(up: Vector3) {
    const east = new Vector3(0, 0, 1).cross(up);
    if (east.lengthSq() < 1e-12) east.set(0, 1, 0);
    east.normalize();
    const north = up.clone().cross(east).normalize();
    return { east, north };
  }

  autoTilt(dist: number): number {
    const t = (Math.log(400e3) - Math.log(dist)) / (Math.log(400e3) - Math.log(2e3));
    const s = Math.min(1, Math.max(0, t));
    return 70 * DEG * s * s * (3 - 2 * s);
  }

  tilt(): number {
    return Math.min(82 * DEG, Math.max(0, this.autoTilt(this.dist) + this.tiltUser));
  }

  /** compass bearing of the screen-up direction at the target, radians (0 = north, +east).
   *  Exactly at a pole north is undefined; 0 is returned there. */
  heading(): number {
    const up = this.tgt;
    const north = new Vector3(0, 0, 1).addScaledVector(up, -up.z);
    if (north.lengthSq() < 1e-12) return 0;
    north.normalize();
    const s = -north.clone().cross(this.fwd).dot(up);
    return Math.atan2(s, north.dot(this.fwd));
  }

  /** smoothly turn the view so north is up (keeps position, zoom and tilt) */
  resetNorth() {
    this.turn = undefined;
    this.headingVel = 0;
    this.northing = true;
    this.changed = true;
  }

  /** smoothly pan so the body-frame direction `dir` ends up at the view centre
   *  (keeps zoom, tilt and heading; any new pointer interaction cancels it) */
  flyTo(dir: Vector3) {
    this.flyGoal = dir.clone().normalize();
    this.omega.set(0, 0, 0);
    this.changed = true;
  }

  // --------------------------------------------------------------- events
  private onDown = (e: PointerEvent) => {
    // the right button is reserved for the site popup (main.ts): no pan / rotate
    if (e.button === 2) return;
    this.flyGoal = null;
    this.turn = undefined;
    this.el.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.dragging = true;
    this.mode = e.shiftKey || e.ctrlKey ? 'rotate' : 'pan';
    this.omega.set(0, 0, 0);
    this.headingVel = 0;
    this.northing = false;
    this.pinch = null;
    this.lastMove = performance.now();
  };

  private onUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    this.pinch = null;
    if (this.pointers.size === 0) {
      this.dragging = false;
      // stop if the pointer rested before release
      if (performance.now() - this.lastMove > 80) {
        this.omega.set(0, 0, 0);
        this.headingVel = 0;
      }
    }
  };

  private groundMetresPerPixel(): number {
    const h = this.el.clientHeight || 1;
    return (this.dist * 2 * Math.tan(this.fovY / 2)) / h;
  }

  private onMove = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    const now = performance.now();
    const dt = Math.max(1e-3, (now - this.lastMove) / 1000);
    this.lastMove = now;

    if (this.pointers.size >= 2) {
      const pts = [...this.pointers.values()];
      const vx = pts[1].x - pts[0].x, vy = pts[1].y - pts[0].y;
      const d = Math.hypot(vx, vy);
      const ang = Math.atan2(vy, vx);
      if (this.pinch) {
        this.zoomBy(-Math.log(Math.max(1,d) / Math.max(1,this.pinch.d)));
        let da = ang - this.pinch.ang;
        if (da > Math.PI) da -= 2 * Math.PI;
        if (da < -Math.PI) da += 2 * Math.PI;
        this.rotateHeading(da);
      }
      this.pinch = { d, ang };
      this.changed = true;
      return;
    }

    if (this.mode === 'rotate') {
      const dh = -dx * 0.005;
      this.rotateHeading(dh);
      this.headingVel = dh / dt;
      this.tiltUser = Math.min(80 * DEG, Math.max(-80 * DEG, this.tiltUser + dy * 0.004));
      this.tiltGoal = this.tiltUser;
      this.changed = true;
      return;
    }
    // pan: move the target opposite to the pointer, by the ground distance under it
    const m = this.groundMetresPerPixel();
    const up = this.tgt;
    const right = this.tmp.copy(this.fwd).cross(up).normalize(); // screen right on the ground
    const move = new Vector3().addScaledVector(right, -dx * m).addScaledVector(this.fwd, dy * m);
    const len = move.length();
    if (len === 0) return;
    const axis = up.clone().cross(move).normalize();
    const angle = len / (R_MOON + this.pivotHeight);
    this.rotateTarget(axis, angle);
    // smoothed angular velocity for inertia
    const w = axis.multiplyScalar(angle / dt);
    this.omega.lerp(w, 0.5);
    this.changed = true;
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 30;
    else if (e.deltaMode === 2) dy *= 300;
    this.zoomBy(Math.max(-300, Math.min(300, dy)) * 0.0022);
    this.changed = true;
  };

  private zoomBy(delta: number) {
    this.logDistGoal += delta;
    this.logDistGoal = Math.min(Math.log(this.maxDist), Math.max(Math.log(this.minDist), this.logDistGoal));
  }

  private rotateTarget(axis: Vector3, angle: number) {
    this.q.setFromAxisAngle(axis, angle);
    this.tgt.applyQuaternion(this.q).normalize();
    this.fwd.applyQuaternion(this.q);
    // re-orthogonalise
    this.fwd.addScaledVector(this.tgt, -this.fwd.dot(this.tgt)).normalize();
  }

  private rotateHeading(a: number) {
    this.q.setFromAxisAngle(this.tgt, a);
    this.fwd.applyQuaternion(this.q).normalize();
  }

  // --------------------------------------------------------------- update
  /** advance inertia; returns true if the view changed */
  update(dt: number): boolean {
    let moved = this.changed;
    this.changed = false;
    if (this.turn) {
      const turn = this.turn;
      turn.elapsed = Math.min(1, turn.elapsed + dt / 0.85);
      const t = turn.elapsed;
      this.q.slerpQuaternions(turn.from, turn.to, t*t*(3-2*t));
      this.tgt.set(0,1,0).applyQuaternion(this.q);
      this.fwd.set(0,0,-1).applyQuaternion(this.q);
      if (t === 1) this.turn = undefined;
      moved = true;
    }
    if (!this.dragging) {
      const w = this.omega.length();
      if (w > 1e-9) {
        const angle = w * dt;
        if (angle * (R_MOON + this.pivotHeight) > 0.01 * this.groundMetresPerPixel()) {
          this.rotateTarget(this.omega.clone().divideScalar(w), angle);
          moved = true;
        }
        this.omega.multiplyScalar(Math.exp(-dt * 4));
        if (w * dt * (R_MOON + this.pivotHeight) < 0.05 * this.groundMetresPerPixel()) this.omega.set(0, 0, 0);
      }
      if (Math.abs(this.headingVel) > 1e-4) {
        this.rotateHeading(this.headingVel * dt);
        this.headingVel *= Math.exp(-dt * 5);
        moved = true;
      } else this.headingVel = 0;
    }
    if (this.flyGoal) {
      const ang = this.tgt.angleTo(this.flyGoal);
      const axis = this.tgt.clone().cross(this.flyGoal);
      if (ang * (R_MOON + this.pivotHeight) < 0.05 * this.groundMetresPerPixel() || axis.lengthSq() < 1e-24) {
        if (axis.lengthSq() >= 1e-24) this.rotateTarget(axis.normalize(), ang);
        this.flyGoal = null;
      } else {
        this.rotateTarget(axis.normalize(), ang * (1 - Math.exp(-dt * 7)));
      }
      moved = true;
    }
    if (this.northing) {
      const h = this.heading();
      if (Math.abs(h) < 1e-4) {
        this.rotateHeading(h);
        this.northing = false;
      } else {
        // ease out; rotateHeading(+a) turns the bearing towards west, i.e. reduces it
        this.rotateHeading(h * (1 - Math.exp(-dt * 7)));
      }
      moved = true;
    }
    // smooth zoom
    const ld = Math.log(this.dist);
    const diff = this.logDistGoal - ld;
    if (Math.abs(diff) > 1e-4 || Math.abs(this.zoomVelocity) > 1e-3) {
      // Exact critically damped spring in log distance, independent of frame rate.
      // Limit catch-up after a burst of wheel events or a missed animation frame.
      const step = Math.min(dt,1/30), stiffness = 12, decay = Math.exp(-stiffness * step);
      const offset = Math.max(-.85,Math.min(.85,diff));
      const transient = this.zoomVelocity - stiffness * offset;
      this.dist = Math.exp(ld + offset + (-offset + transient * step) * decay);
      this.zoomVelocity = (this.zoomVelocity - stiffness * transient * step) * decay;
      moved = true;
    } else if (diff !== 0) {
      this.dist = Math.exp(this.logDistGoal);
      this.zoomVelocity = 0;
      moved = true;
    }
    // pivot height follows the terrain
    const h = this.heightAt([this.tgt.x, this.tgt.y, this.tgt.z]);
    if (h !== null && Math.abs(h - this.pivotHeight) > 0.01) {
      this.pivotHeight += (h - this.pivotHeight) * (1 - Math.exp(-dt * 8));
      moved = true;
    }
    return moved;
  }

  state(): ControlsState {
    const up = this.tgt;
    const tau = this.tilt();
    const pivot = up.clone().multiplyScalar(R_MOON + this.pivotHeight);
    const z = up.clone().multiplyScalar(Math.cos(tau)).addScaledVector(this.fwd, -Math.sin(tau)); // camera back
    let cam = pivot.clone().addScaledVector(z, this.dist);
    // keep the camera above the terrain
    const camR = cam.length();
    const camDir = cam.clone().divideScalar(camR);
    const hc = this.heightAt([camDir.x, camDir.y, camDir.z]);
    const minR = R_MOON + (hc ?? this.pivotHeight) + this.minClearance;
    if (camR < minR) cam = camDir.multiplyScalar(minR);
    const zc = cam.clone().sub(pivot).normalize();
    const yHint = this.fwd.clone().multiplyScalar(Math.cos(tau)).addScaledVector(up, Math.sin(tau));
    const xc = yHint.clone().cross(zc).normalize();
    const yc = zc.clone().cross(xc).normalize();
    const viewRot = new Matrix3().set(xc.x, xc.y, xc.z, yc.x, yc.y, yc.z, zc.x, zc.y, zc.z);
    return { camPos: [cam.x, cam.y, cam.z], viewRot, pivot: [pivot.x, pivot.y, pivot.z] };
  }

  isAnimating(): boolean {
    return this.dragging || this.northing || this.flyGoal !== null || this.omega.lengthSq() > 0 || this.headingVel !== 0 ||
      Math.abs(this.logDistGoal - Math.log(this.dist)) > 1e-4;
  }
}
