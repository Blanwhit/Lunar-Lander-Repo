import { CanvasTexture, Group, Mesh, MeshBasicMaterial, PlaneGeometry, Quaternion, Ray,
  RingGeometry, SRGBColorSpace, Vector3 } from 'three';
import { R_MOON } from './geom';
import type { SurfaceLocation, WalkTerrain } from './walkTerrain';
import type { WalkGround } from './walkGround';
import type { SpecimenInfo } from './specimenInfo';

const rad = Math.PI / 180;
export function waypointReading(from: SurfaceLocation, to: SurfaceLocation) {
  const a = from.lat*rad, b = to.lat*rad, dl = (to.lon-from.lon)*rad;
  const h = Math.sin((b-a)/2)**2 + Math.cos(a)*Math.cos(b)*Math.sin(dl/2)**2;
  const distance = 2*R_MOON*Math.asin(Math.sqrt(Math.min(1,Math.max(0,h))));
  const bearing = Math.atan2(Math.sin(dl)*Math.cos(b),Math.cos(a)*Math.sin(b)-Math.sin(a)*Math.cos(b)*Math.cos(dl));
  return { distance, bearing: (Math.round(bearing/rad)+360)%360, rise: to.elevation-from.elevation };
}
const metres = (d: number) => d >= 1000 ? (d/1000).toFixed(2)+' km' : d.toFixed(d<10?1:0)+' m';

export class WristNavigator {
  readonly group = new Group();
  private readonly canvas = document.createElement('canvas');
  private readonly texture: CanvasTexture;
  private readonly panel: Mesh<PlaneGeometry,MeshBasicMaterial>;
  private readonly ring = new Mesh(new RingGeometry(.77,1,32),new MeshBasicMaterial({color:0xd9ebad,toneMapped:false}));
  private destination?: SurfaceLocation;
  private lastDistance = 0;
  private lastMovement = 0;
  private trend = 'Marked';
  private aiming = false;
  private nextAim = 0;
  private nextDisplay = 0;
  private readonly v = new Vector3();

  constructor() {
    this.canvas.width=640; this.canvas.height=400;
    this.texture=new CanvasTexture(this.canvas); this.texture.colorSpace=SRGBColorSpace;
    this.panel=new Mesh(new PlaneGeometry(.168,.105),new MeshBasicMaterial({map:this.texture,toneMapped:false}));
    this.group.add(this.panel,this.ring); this.hide();
  }

  hide() { this.panel.visible=this.ring.visible=this.aiming=false; this.nextAim=this.nextDisplay=0; }

  aim(pressed: boolean, ray: Ray | undefined, eye: Vector3, ground: WalkGround, terrain: WalkTerrain,
    x: number, z: number, time: number) {
    if (!ray) { this.aiming=false; this.ring.visible=false; return; }
    if (!pressed && !this.aiming) return;
    if (pressed && this.aiming && time < this.nextAim) return;
    const hit = ground.intersect(ray);
    if (pressed && hit) {
      this.ring.position.copy(hit);
      this.v.subVectors(eye,hit);
      const distance=this.v.length();
      this.ring.position.addScaledVector(this.v.normalize(),Math.max(.015,distance*.001));
      this.ring.lookAt(eye); this.ring.scale.setScalar(Math.max(.025,distance*.005));
    } else if (!pressed && hit) {
      this.destination=terrain.coordinates(hit.x,hit.z);
      this.trend='Marked'; this.lastMovement=time;
      this.lastDistance=waypointReading(terrain.coordinates(x,z),this.destination).distance;
      this.nextDisplay=0;
    }
    this.ring.visible=pressed && !!hit; this.aiming=pressed; this.nextAim=time+85;
  }

  wrist(hand: Vector3 | undefined, rotation: Quaternion, eye: Vector3, view: Vector3,
    terrain: WalkTerrain, x: number, z: number, sample: SpecimenInfo | undefined, time: number) {
    this.panel.visible=!!hand && hand.y>eye.y-.48 && hand.y<eye.y+.23 &&
      hand.distanceToSquared(eye)<.9**2 && this.v.subVectors(hand,eye).normalize().dot(view)>.5;
    if (!this.panel.visible || !hand) { this.nextDisplay=0; return; }
    this.panel.position.copy(this.v.set(0,.045,.085).applyQuaternion(rotation)).add(hand);
    this.panel.lookAt(eye);
    if (time<this.nextDisplay) return;
    this.nextDisplay=time+160;
    const c=this.canvas.getContext('2d')!;
    c.fillStyle='#152125'; c.fillRect(0,0,640,400);
    c.strokeStyle='#71827e'; c.lineWidth=6; c.strokeRect(3,3,634,394);
    const line=(str:string,y:number,size:number,color='#edf4ec')=>{
      c.fillStyle=color;c.font='500 '+size+'px system-ui, sans-serif';c.fillText(str,24,y,592);
    };
    line('NAVIGATION',47,30,'#c7daa0');
    if (this.destination) {
      const r=waypointReading(terrain.coordinates(x,z),this.destination);
      const change=this.lastDistance-r.distance;
      if (Math.abs(change)>.12) {
        this.trend=change>0?'Getting closer':'Moving away';
        this.lastDistance=r.distance; this.lastMovement=time;
      } else if (time-this.lastMovement>1200) this.trend='Steady';
      const relative=r.bearing*rad - Math.atan2(view.x,-view.z);
      c.save(); c.translate(568,94); c.rotate(relative);
      c.beginPath(); c.moveTo(0,-28); c.lineTo(16,17); c.lineTo(0,9); c.lineTo(-16,17);
      c.closePath(); c.fillStyle='#c7daa0'; c.fill(); c.restore();
      line(metres(r.distance)+'   ·   '+String(r.bearing).padStart(3,'0')+'° true',111,50);
      line(Math.round(Math.abs(r.rise))+' m '+(r.rise<0?'lower':'higher')+'   ·   '+
        this.trend,166,32);
    } else {
      line('Point at a ridge with your right hand.',104,32);
      line('Hold B to aim. Release to mark.',161,34);
    }
    c.fillStyle='#53635f'; c.fillRect(24,194,592,2);
    if (sample) {
      line(sample.mission+'  /  '+sample.sampleId,246,36,'#c7daa0');
      line(sample.name,303,43);
      line('Original scan   '+sample.size,363,34);
    } else {
      line('FIELD SAMPLES',249,30,'#c7daa0');
      line('Reach for a loose rock.',304,35);
      line('Squeeze the right grip to inspect.',358,33);
    }
    this.texture.needsUpdate=true;
  }

  dispose() {
    this.texture.dispose(); this.panel.geometry.dispose();this.panel.material.dispose();
    this.ring.geometry.dispose(); this.ring.material.dispose();this.group.clear();
  }
}
