import { Quaternion, Vector3 } from 'three';

// Positions are in metres from the centre of mass. Impulses are divided by mass.
// Nominal mass properties and footprint from NASA NTRS 20260001760, tables 1 and 2.
// The model uses +Y for the LM vertical axis.
const gravity = 1.625;
const inverseInertia = new Vector3(7063.5 / 17409, 7063.5 / 16492, 7063.5 / 20800);
export const centreHeight = 3.62;
export const padRadius = 4.242;
const contacts = [
  [padRadius,0,0], [-padRadius,0,0], [0,0,padRadius], [0,0,-padRadius],
  // Descent stage and upper cabin can also bear weight after a rollover.
  [0,.38,0],
  ...[-1.55,1.55].flatMap(x => [-1.55,1.55].map(z => [x,1.1,z])),
  ...[-1.25,1.25].flatMap(x => [-1.15,1.15].map(z => [x,5.8,z])),
].map(([x,y,z]) => new Vector3(x,y-centreHeight,z));

/** Sample the locally rendered soil and boulders once per grid vertex. */
export class LandingBed {
  private samples = new Map<number,Map<number,number>>();
  constructor(private height: (x:number,z:number)=>number) {}
  private vertex(i:number,j:number) {
    let row = this.samples.get(i);
    if (!row) { row = new Map(); this.samples.set(i,row); }
    let h = row.get(j);
    if (h === undefined) { h=this.height(i*.18,j*.18); row.set(j,h); }
    return h;
  }
  at(x:number,z:number,normal?:Vector3) {
    const gx=x/.18,gz=z/.18,i=Math.floor(gx),j=Math.floor(gz),u=gx-i,v=gz-j;
    const a=this.vertex(i,j),b=this.vertex(i+1,j),c=this.vertex(i,j+1),d=this.vertex(i+1,j+1);
    if(normal) normal.set(-((b-a)*(1-v)+(d-c)*v)/.18,1,-((c-a)*(1-u)+(d-b)*u)/.18).normalize();
    return (a*(1-u)+b*u)*(1-v)+(c*(1-u)+d*u)*v;
  }
}

export class LanderDynamics {
  readonly position = new Vector3();
  readonly rotation = new Quaternion();
  readonly velocity = new Vector3();
  readonly spin = new Vector3();
  contacted = false;
  settled = false;
  tilt = 0;
  private quiet = 0;
  private inverse = new Quaternion();
  private axis = new Vector3();
  private angular = new Vector3();
  private impulse = new Vector3();
  private motion = new Vector3();
  private dq = new Quaternion();
  private points = contacts.map(() => ({arm:new Vector3(),normal:new Vector3(),depth:0,load:0,friction:new Vector3()}));
  constructor(private bed:LandingBed) {}
  private inertia(v:Vector3) {
    return v.applyQuaternion(this.inverse).multiply(inverseInertia).applyQuaternion(this.rotation);
  }
  private massAlong(r:Vector3,n:Vector3) {
    return 1+this.inertia(this.angular.crossVectors(r,n)).cross(r).dot(n);
  }
  private apply(r:Vector3,j:Vector3) {
    this.velocity.add(j);
    this.spin.add(this.inertia(this.angular.crossVectors(r,j)));
  }
  step(dt:number) {
    if(this.settled)return;
    this.velocity.y-=gravity*dt;
    this.position.addScaledVector(this.velocity,dt);
    const omega=this.spin.length();
    if(omega>1e-8)this.rotation.premultiply(this.dq.setFromAxisAngle(this.axis.copy(this.spin).multiplyScalar(1/omega),omega*dt)).normalize();
    this.inverse.copy(this.rotation).invert();
    let count=0;
    for(let i=0;i<contacts.length;i++){
      const p=this.points[i],r=p.arm.copy(contacts[i]).applyQuaternion(this.rotation);
      const h=this.bed.at(this.position.x+r.x,this.position.z+r.z,p.normal);
      p.depth=(h-this.position.y-r.y)*p.normal.y;
      p.load=0;p.friction.set(0,0,0);
      if(p.depth>=-.001){count++;this.contacted=true;}
    }
    // Unilateral normal impulses and Coulomb friction at each actual point of contact.
    for(let pass=0;count && pass<7;pass++)for(const p of this.points){
      if(p.depth<-.001)continue;
      const r=p.arm,n=p.normal,v=this.motion.crossVectors(this.spin,r).add(this.velocity);
      const bias=Math.min(.8,Math.max(0,p.depth-.004)*.16/dt);
      const load=Math.max(0,p.load+(bias-v.dot(n))/this.massAlong(r,n));
      this.apply(r,this.impulse.copy(n).multiplyScalar(load-p.load));
      p.load=load;
      v.crossVectors(this.spin,r).add(this.velocity);
      v.addScaledVector(n,-v.dot(n));
      const speed=v.length();
      if(speed<1e-7)continue;
      const tangent=v.multiplyScalar(1/speed);
      const next=this.impulse.copy(p.friction).addScaledVector(tangent,-speed/this.massAlong(r,tangent)).clampLength(0,.72*load);
      this.axis.copy(next).sub(p.friction);
      p.friction.copy(next);
      this.apply(r,this.axis);
    }
    this.tilt=Math.acos(Math.min(1,Math.max(-1,this.axis.set(0,1,0).applyQuaternion(this.rotation).y)));
    this.quiet=count>=3 && this.velocity.lengthSq()<.00036 && this.spin.lengthSq()<.000064 ? this.quiet+dt : 0;
    this.settled=this.quiet>.8;
    if(this.settled){this.velocity.set(0,0,0);this.spin.set(0,0,0);}
  }
}
