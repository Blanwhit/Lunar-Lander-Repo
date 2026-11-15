import { MathUtils, Vector3 } from 'three';
import { lunarGravity } from './walkGait';

import { soleLength } from './walkOutsole';
type Floor = (x: number, z: number) => number;
const ease = (t: number) => MathUtils.smoothstep(t, 0, 1);
const angleTo = (a: number, b: number) => Math.atan2(Math.sin(b-a), Math.cos(b-a));

export class BootPose {
  readonly center = new Vector3();
  readonly across = new Vector3();
  readonly along = new Vector3();
  readonly up = new Vector3();
  readonly home = new Vector3();
  readonly start = new Vector3();
  yaw = 0;
  startYaw = 0;
  clearance = 0;
  startClearance = 0;
  loadedFor = -1;
  contact = false;
  pitch = 0;
  startPitch = 0;
  strikePitch = 0;
  sink = 0;
  bedOffset = 0;
  impactSpeed = 0;
  onStone = false;

  setBed(offset: number | null) {
    this.onStone = offset === null;
    this.bedOffset = offset ?? 0;
    if (this.onStone) this.sink = 0;
  }
  settledFor = 0;
  private previousBedHeight = Infinity;
  private previousPitch = 0;
  constructor(readonly side: number) {}

  release() {
    this.start.copy(this.center);
    this.startYaw = this.yaw;
    this.startClearance = this.clearance + this.bedOffset - this.sink;
    this.bedOffset = 0;
    this.startPitch = this.pitch;
    this.sink = 0;
    this.loadedFor = -1;
    this.settledFor = 0;
  }

  orient(floor: Floor, scale: number, loadFraction:number, dt:number) {
    const {x,z} = this.center, r = .09 * scale;
    const gx = (floor(x+r,z) - floor(x-r,z))/(2*r);
    const gz = (floor(x,z+r) - floor(x,z-r))/(2*r);
    this.up.set(-gx,1,-gz).normalize();
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    this.along.set(fx,gx*fx+gz*fz,fz).normalize();
    this.across.crossVectors(this.up,this.along).normalize();
    if (this.loadedFor>=0 && !this.onStone) {
      const t=this.loadedFor;
      // A finite loading pulse transfers downward momentum while the knee yields.
      const tau=.095;
      const deceleration=this.impactSpeed*t*Math.exp(-t/tau)/(tau*tau);
      const force=145*loadFraction*(lunarGravity*(-Math.expm1(-t/.09))+deceleration);
      const pressure=force/(.036*scale*scale);
      const equilibrium=.019*Math.pow(Math.max(0,pressure)/7000,.72);
      this.sink=Math.max(this.sink,MathUtils.lerp(this.sink,Math.max(0,Math.min(.046,equilibrium)+Math.min(0,this.bedOffset)),-Math.expm1(-dt*13)));
    }
    const roll=this.pitch;
    this.along.applyAxisAngle(this.across,-roll);
    this.up.crossVectors(this.along,this.across);
    const pivotLift=Math.abs(Math.sin(roll))*soleLength*.48*scale;
    this.center.y = floor(x,z) + this.clearance + pivotLift + this.bedOffset - this.sink;
    if (Math.abs(this.center.y-this.previousBedHeight)>.00004 || Math.abs(roll-this.previousPitch)>.001 || this.contact) {
      this.previousBedHeight=this.center.y;this.previousPitch=roll;this.settledFor=0;
    } else this.settledFor+=dt;
  }
}

/** Both inverse kinematics and the dust renderer consume these same world-space soles. */
export class WalkFeet {
  readonly boots = [new BootPose(-1), new BootPose(1)];
  private ready = false;
  private flying = false;
  private next = 0;
  private swing = -1;
  private progress = 0;
  private duration = 0;
  private age = 0;
  private readonly velocity = new Vector3();
  private readonly destination = new Vector3();

  reset() { this.ready = false; }

  update(base: Vector3, yaw: number, scale: number, dx: number, dz: number, dt: number,
         airborne: boolean, lift: number, landing: boolean, floor: Floor, impactSpeed:number,
         bedAt:(boot:BootPose,scale:number)=>number|null) {
    const sin = Math.sin(yaw), cos = Math.cos(yaw);
    for (const boot of this.boots) {
      const offset = boot.side * .16505 * scale, toe = .15 * scale;
      boot.home.set(base.x + offset*cos + toe*sin, 0, base.z - offset*sin + toe*cos);
      boot.contact = false;
    }
    if (!this.ready || Math.hypot(dx,dz) > .65) {
      this.swing = -1;
      this.flying = false;
      this.next = 0;
      this.velocity.set(0,0,0);
      for (const boot of this.boots) {
        boot.center.copy(boot.home);
        boot.yaw = yaw;
        boot.clearance = 0;
        boot.loadedFor = 0; boot.sink=boot.pitch=boot.impactSpeed=boot.strikePitch=0;
        boot.setBed(bedAt(boot,scale));
      }
      this.ready = true;
    } else if (dt > 0) {
      const blend = -Math.expm1(-14*dt);
      this.velocity.x += (dx/dt-this.velocity.x)*blend;
      this.velocity.z += (dz/dt-this.velocity.z)*blend;
      this.velocity.clampLength(0,4.5);
    }

    if (airborne || this.flying) {
      if (!this.flying) {
        this.swing = -1;
        this.age = 0;
        for (const boot of this.boots) {
          boot.release();
          // Keep the takeoff offset while the body starts to translate.
          boot.start.sub(boot.home);
        }
      }
      this.age += dt;
      const t = ease(this.age/.23);
      this.boots.forEach((boot,i) => {
        const lead = landing ? 0 : (i === this.next ? 1 : -1) * .065 * scale;
        boot.center.copy(boot.home).addScaledVector(boot.start,1-t).addScaledVector(this.velocity,lead*t);
        boot.yaw = boot.startYaw + t*angleTo(boot.startYaw,yaw);
        boot.clearance = Math.max(0,base.y-floor(boot.center.x,boot.center.z)) + Math.min(.09*scale,Math.max(0,lift)*.6)
          + (1-t)*boot.startClearance + (!landing && i !== this.next ? .045*scale*t : 0);
        const roll=landing ? .05 : i===this.next ? .14 : -.22;
        boot.pitch=MathUtils.lerp(boot.startPitch,roll,t);
        if (!airborne && (landing || i === this.next)) this.touch(boot,impactSpeed);
      });
      if (!airborne) {
        this.next = 1-this.next;
        if (!landing) {
          // The trailing boot continues its recovery while the leading boot takes the load.
          this.beginSwing(this.next,scale);
        }
      }
      this.flying = airborne;
    } else if (landing) {
      for (const boot of this.boots) this.touch(boot,impactSpeed);
      this.swing = -1;
    } else {
      if (this.swing < 0) {
        for (const index of [this.next,1-this.next]) {
          const b = this.boots[index];
          if (Math.hypot(b.home.x-b.center.x,b.home.z-b.center.z) > .16*scale ||
              Math.abs(angleTo(b.yaw,yaw)) > .59) {
            this.beginSwing(index,scale);
            break;
          }
        }
      }
      if (this.swing >= 0) {
        const b = this.boots[this.swing];
        this.progress = Math.min(1,this.progress+dt/this.duration);
        const t = ease(this.progress);
        this.destination.copy(b.home).addScaledVector(this.velocity, Math.min(.14, .20*scale/(this.velocity.length() || 1)));
        b.center.lerpVectors(b.start,this.destination,t);
        b.yaw = b.startYaw + t*angleTo(b.startYaw,yaw);
        const stride = this.progress;
        // Flex the ankle on recovery; dorsiflex the leading foot before heel strike.
        const forward = this.velocity.x*sin+this.velocity.z*cos;
        const leading = MathUtils.clamp(forward, -.8, 1);
        b.pitch = (1-t)*b.startPitch + leading*(.16*t-.27*Math.sin(Math.PI*stride));
        b.clearance = (1-t)*b.startClearance + (.050+.035*Math.min(1,this.velocity.length()))*scale*
          Math.sin(Math.PI*stride)**2*(1.25-.5*stride);
        if (this.progress === 1) {
          this.touch(b,.12+.18*this.velocity.length());
          this.next = 1-this.swing;
          this.swing = -1;
        }
      }
    }
    for (const b of this.boots) {
      if(b.contact)b.setBed(bedAt(b,scale));
      if (!b.contact && b.loadedFor >= 0) b.loadedFor += dt;
      if (b.loadedFor>=0) {
        const behind=(b.home.x-b.center.x)*sin+(b.home.z-b.center.z)*cos;
        const pushOff=MathUtils.smoothstep(behind/scale,.06,.34);
        b.pitch=b.strikePitch*Math.exp(-b.loadedFor/.10)-.30*pushOff*ease(b.loadedFor/.18);
      }
      const supports = this.boots[0].loadedFor>=0 && this.boots[1].loadedFor>=0 ? 2 : 1;
      b.orient(floor,scale,1/supports,dt);
    }
  }

  private beginSwing(index: number, scale: number) {
    this.swing = index;
    this.progress = 0;
    this.duration = MathUtils.clamp(.39*scale / Math.max(.1,this.velocity.length()),.19,.34);
    this.boots[index].release();
  }

  private touch(boot: BootPose, impact:number) {
    boot.impactSpeed=impact;
    boot.strikePitch=boot.pitch;
    boot.contact = true;
    boot.clearance = 0;
    boot.loadedFor = 0;
  }
}
