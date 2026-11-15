export const lunarGravity = 1.62; // m/s²
export const walkSpeed = 1.5, sprintSpeed = 4.2; // m/s on level ground

/** Stick turning integrates angular velocity about the tracked head position. */
export class WalkTurn {
  private rate = 0;

  reset() { this.rate = 0; }

  advance(stick: number, dt: number): number {
    const target = -Math.sign(stick) * Math.abs(stick) ** 1.5 * Math.PI / 2;
    const response = target === 0 ? 22 : 12;
    const blend = -Math.expm1(-response * dt);
    const angle = target * dt + (this.rate - target) * blend / response;
    this.rate += (target - this.rate) * blend;
    return angle;
  }
}

/** Foot contact supplies traction. Between contacts the body follows a ballistic arc. */
export class WalkGait {
  vx = 0;
  vz = 0;
  lift = 0;
  supportY = 0;
  touchdownSpeed = 0;
  compression = 0;
  private compressionRate = 0;
  private vy = 0;
  private stanceTravel = 0;
  private airborne = false;

  get inFlight() { return this.airborne; }

  jumping = false;
  private jumpQueued = false;
  private altitude = 0;

  requestJump() {
    // A press during the short flight phase of a stride takes effect at the next contact.
    if (!this.jumping) this.jumpQueued = true;
  }

  reset() {
    this.jumping = this.jumpQueued = false;
    this.vx = this.vz = this.vy = this.lift = this.stanceTravel = 0;
    this.airborne = false;
    this.touchdownSpeed = this.compression = this.compressionRate = 0;
  }

  step(body: { x: number; z: number }, east: number, south: number, dt: number,
       ground: { floorAt(x: number, z: number): number; surfaceAt?(x: number, z: number, radius?: number): number },
       running = false, sprint = 0) {
    // Leg suspension carries the vertical velocity continuously through a virtual landing.
    const stiffness = 9, response = this.compressionRate + stiffness*this.compression;
    const decay = Math.exp(-stiffness*dt);
    this.compressionRate = (this.compressionRate-stiffness*response*dt)*decay;
    this.compression = (this.compression+response*dt)*decay;
    const support = (x: number, z: number) => ground.surfaceAt?.(x, z, .12) ?? ground.floorAt(x, z);
    const floor = support(body.x, body.z);
    const soil = ground.floorAt(body.x, body.z);
    const input = Math.hypot(east, south);
    if (!this.airborne) {
      const grade = input > 0
        ? (ground.floorAt(body.x + 0.5 * east / input, body.z + 0.5 * south / input) - soil) / 0.5 : 0;
      const pace = (sprint > 0 ? walkSpeed + sprint * (sprintSpeed-walkSpeed) : running ? 3.1 : walkSpeed) / (1 + 1.5 * Math.max(0, grade) + 0.6 * Math.max(0, -grade));
      const dx = east * pace - this.vx, dz = south * pace - this.vz;
      const slope = Math.atan(grade);
      // Resolve surface traction and the downhill component of gravity along the intended stride.
      const traction = input > 0
        ? Math.max(.55,lunarGravity*(1.08*Math.cos(slope)-Math.sin(slope)))
        : lunarGravity * .90;
      const fraction = Math.min(1, traction * dt / (Math.hypot(dx, dz) || 1));
      this.vx += dx * fraction;
      this.vz += dz * fraction;
      if (this.jumpQueued) {
        this.jumpQueued = false;
        this.jumping = this.airborne = true;
        this.altitude = floor;
        // A directional jump can push off from rest. Steering after takeoff comes from contact.
        if (input > 0) {
          const along = (this.vx*east + this.vz*south) / input;
          const push = Math.max(0, .9*input - along);
          this.vx += east/input * push; this.vz += south/input * push;
        }
        this.vy = 1.45; // Chosen suited push-off speed in m/s.
        this.stanceTravel = 0;
      }
    }

    const oldX = body.x, oldZ = body.z;
    const dx = this.vx * dt, dz = this.vz * dt;
    const flightY = this.altitude + this.vy*dt - .5*lunarGravity*dt*dt;
    // A low lip can be stepped onto. Taller ledges must be cleared by the ballistic arc.
    const canMove = (x: number, z: number) => {
      const top = support(x, z), terrain = ground.floorAt(x, z);
      if (top <= terrain + (this.airborne ? .001 : .12)) return true;
      const reachable = this.airborne ? Math.max(this.altitude, flightY)
        : floor + .85 * Math.hypot(x-oldX, z-oldZ);
      return top <= reachable + .0001;
    };
    if ((dx || dz) && !canMove(oldX + dx, oldZ + dz)) {
      // Project velocity onto the tangent of the contacted rock face.
      const x = oldX+dx, z = oldZ+dz, e = .035;
      const gx = support(x+e,z) - support(x-e,z), gz = support(x,z+e) - support(x,z-e);
      const norm = gx*gx + gz*gz;
      const into = norm > 1e-12 ? Math.max(0, (gx*this.vx + gz*this.vz)/norm) : 0;
      this.vx -= into*gx; this.vz -= into*gz;
      if (canMove(oldX + this.vx*dt, oldZ + this.vz*dt)) {
        body.x += this.vx*dt; body.z += this.vz*dt;
      } else {
        if (canMove(oldX + this.vx*dt, oldZ)) body.x += this.vx*dt; else this.vx = 0;
        if (canMove(body.x, oldZ + this.vz*dt)) body.z += this.vz*dt; else this.vz = 0;
      }
    } else {
      body.x += dx; body.z += dz;
    }
    const nextFloor = this.supportY = support(body.x, body.z);
    // A discontinuous lip changes support without imparting an unbounded vertical impulse.
    const slopeSpeedLimit = .85*Math.hypot(this.vx, this.vz);
    const slopeSpeed = Math.max(-slopeSpeedLimit, Math.min(slopeSpeedLimit, (nextFloor-floor)/dt));
    // Walking off a ledge starts a fall from its actual height.
    if (!this.airborne && floor-nextFloor > Math.max(.025, 1.15*Math.hypot(dx,dz))) {
      this.airborne = true; this.altitude = floor; this.vy = 0;
    }
    if (this.airborne) {
      this.altitude += this.vy * dt - 0.5 * lunarGravity * dt * dt;
      this.lift = this.altitude - nextFloor;
      this.vy -= lunarGravity * dt;
      if (this.lift <= 0) {
        this.touchdownSpeed = Math.max(0,slopeSpeed-this.vy);
        this.compressionRate = Math.min(2.1,this.touchdownSpeed);
        this.lift = this.vy = 0;
        this.airborne = false;
        const contact = this.jumping ? 'landing' : 'step';
        this.jumping = false;
        return contact;
      }
      return;
    }

    const distance = Math.hypot(body.x - oldX, body.z - oldZ);
    const speed = distance / dt;
    if (speed < 0.005) {
      this.stanceTravel = 0;
      return;
    }
    this.stanceTravel += distance;
    if (this.stanceTravel >= 0.32 + 0.12 * speed) {
      this.stanceTravel = 0;
      if (input < .01 || (!running && sprint <= 0) || speed < .85) return 'step'; // A walking stride rolls through continuous support.
      // Carry the velocity along the slope at takeoff, then add the foot's upward push.
      this.vy = slopeSpeed + Math.min(.56, (speed - .45) * .38);
      this.altitude = nextFloor;
      this.airborne = true;
    }
  }
}
