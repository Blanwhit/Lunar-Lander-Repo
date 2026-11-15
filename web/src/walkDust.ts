import {
  Color, DynamicDrawUsage, IcosahedronGeometry, InstancedMesh, MeshLambertMaterial,
  Object3D, Vector3,
} from 'three';
import { lunarGravity } from './walkGait';

const capacity = 1536;
interface DustBed {
  floorAt(x:number,z:number):number;
  deposit(x:number,z:number,volume:number):void;
}

/** Each visible aggregate carries disturbed soil back into the surface. */
export class WalkDust {
  readonly mesh = new InstancedMesh(new IcosahedronGeometry(1,0),
    new MeshLambertMaterial({color:0xffffff}),capacity);
  private readonly parcels = Array.from({length:capacity},()=>({
    position:new Vector3(),velocity:new Vector3(),radius:0,volume:0,
  }));
  private readonly transform = new Object3D();

  constructor(private readonly bed:DustBed) {
    this.mesh.count=0;this.mesh.frustumCulled=false;this.mesh.receiveShadow=true;
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    const tint=new Color();
    for(let i=0;i<capacity;i++){
      const gray=.10+Math.random()*.10;
      this.mesh.setColorAt(i,tint.setRGB(gray,gray*.98,gray*.95));
    }
  }

  eject(x:number,z:number,dx:number,dz:number,speed:number,available:number) {
    if (Math.random()>.32) return 0;
    return this.launch(x,z,dx,dz,speed,available);
  }

  launch(x:number,z:number,dx:number,dz:number,speed:number,available:number) {
    if (this.mesh.count===capacity || available<2e-9) return 0;
    const grain=this.parcels[this.mesh.count++];
    grain.volume=Math.min(available,3e-8);
    grain.radius=Math.cbrt(grain.volume*3/(4*Math.PI));
    grain.position.set(x,this.bed.floorAt(x,z)+grain.radius,z);
    const shear=speed*(.3+.7*Math.random()),scatter=(Math.random()-.5)*.5;
    grain.velocity.set((dx-dz*scatter)*shear,(.22+.7*Math.random())*speed,(dz+dx*scatter)*shear);
    return grain.volume;
  }

  update(dt:number) {
    let i=0;
    while(i<this.mesh.count) {
      const g=this.parcels[i],p=g.position,v=g.velocity;
      p.addScaledVector(v,dt);p.y-=.5*lunarGravity*dt*dt;v.y-=lunarGravity*dt;
      if(v.y<0 && p.y<=this.bed.floorAt(p.x,p.z)+g.radius) {
        this.bed.deposit(p.x,p.z,g.volume);
        const last=--this.mesh.count;
        this.parcels[i]=this.parcels[last];this.parcels[last]=g;
        continue;
      }
      this.transform.position.copy(p);this.transform.scale.set(g.radius,g.radius*.82,g.radius);
      this.transform.updateMatrix();this.mesh.setMatrixAt(i,this.transform.matrix);
      i++;
    }
    if(i){this.mesh.instanceMatrix.addUpdateRange(0,i*16);this.mesh.instanceMatrix.needsUpdate=true;}
  }

  dispose() {
    this.mesh.geometry.dispose();this.mesh.material.dispose();this.mesh.dispose();
  }
}
