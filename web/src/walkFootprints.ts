import {
  BufferAttribute, BufferGeometry, DataTexture, DynamicDrawUsage, Group, Mesh,
  MeshStandardMaterial, NearestFilter, RedFormat, Vector2,
} from 'three';
import { decodeSoil, encodeSoil, type CastSoilTile } from './castSoil';
import type { BootPose } from './walkFeet';
import { type WalkOutsole, soleLength, soleWidth, rimBins } from './walkOutsole';
import type { WalkGround } from './walkGround';
import type { WalkDust } from './walkDust';

const tileSize = .5, cells = 64, row = cells+1, spacing = tileSize/cells;
const area = spacing*spacing, span = 64;
const key = (x:number,z:number) => x*67108864+z;
const attribute = (array: Float32Array, size: number) => new BufferAttribute(array,size);

// All levels share edge vertices. Even a coarse neighbouring tile meets the same original ground.
const levels = [1,2,4].map(stride => {
  const indices = [];
  for (let z=0; z<cells; z+=stride) for (let x=0; x<cells; x+=stride) {
    const a=z*row+x, b=a+stride, c=a+row*stride, d=c+stride;
    indices.push(a,c,b,b,c,d);
  }
  return new BufferAttribute(new Uint16Array(indices),1);
});

class SoilTile {
  readonly displacement = new Float32Array(row*row);
  revision = 0;
  sentRevision = -1;
  lastSent = -Infinity;
  mesh?: Mesh<BufferGeometry,MeshStandardMaterial>;
  base?: Float32Array;
  normals?: Float32Array;
  shade?: Float32Array;
  minX=0; minZ=0; maxX=cells; maxZ=cells;
  constructor(readonly x:number, readonly z:number) {}
  dirty(x:number,z:number) {
    this.minX=Math.min(this.minX,x); this.maxX=Math.max(this.maxX,x);
    this.minZ=Math.min(this.minZ,z); this.maxZ=Math.max(this.maxZ,z);
  }
  release() {
    this.mesh?.removeFromParent(); this.mesh?.geometry.dispose(); this.mesh=undefined;
    this.base=this.normals=this.shade=undefined;
  }
}

/** Persistent plastic deformation in metres on a world-aligned 7.8 mm lattice. */
export class WalkFootprints {
  readonly group = new Group();
  readonly trailId = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
  private nextSend = 0;
  private transmissions = 0;
  private readonly tiles = new Map<number,SoilTile>();
  private readonly visible = new Set<SoilTile>();
  private readonly pixels = new Uint8Array(span*span);
  private readonly mask = new DataTexture(this.pixels,span,span,RedFormat);
  private readonly origin = new Vector2(Infinity,Infinity);
  private readonly material: MeshStandardMaterial;
  private maskDirty = true;
  private readonly displaced = new Float64Array(rimBins);
  private readonly appearance = new Float32Array(7);
  constructor(private readonly ground: WalkGround, private readonly outsoles: WalkOutsole[]) {
    this.mask.minFilter=this.mask.magFilter=NearestFilter;
    this.mask.needsUpdate=true;
    this.material=ground.soilMaterial(this.mask,this.origin,tileSize,span);
  }

  private tile(x:number,z:number) {
    const id=key(x,z);
    let tile=this.tiles.get(id);
    if (!tile) {
      tile=new SoilTile(x,z); this.tiles.set(id,tile);
      this.maskDirty=true;
    }
    return tile;
  }

  private sample(i:number,j:number) {
    const tile=this.tiles.get(key(Math.floor(i/cells),Math.floor(j/cells)));
    return tile?.displacement[(j & (cells-1))*row+(i & (cells-1))] ?? 0;
  }

  private change(i:number,j:number,amount:number) {
    const tx=Math.floor(i/cells), tz=Math.floor(j/cells), x=i & (cells-1), z=j & (cells-1);
    // Duplicate border samples into both meshes so a loaded sole can straddle tile boundaries.
    for(let dz=0;dz<=(z===0?1:0);dz++) for(let dx=0;dx<=(x===0?1:0);dx++) {
      const tile=this.tile(tx-dx,tz-dz), a=x+dx*cells,b=z+dz*cells;
      tile.displacement[b*row+a]+=amount;
      tile.revision++;
      tile.dirty(a,b);
    }
  }

  floorAt(x:number,z:number) {
    const u=x/spacing,v=z/spacing,i=Math.floor(u),j=Math.floor(v),a=u-i,b=v-j;
    const sw=this.sample(i,j),se=this.sample(i+1,j),nw=this.sample(i,j+1),ne=this.sample(i+1,j+1);
    const shift=a+b<1 ? sw*(1-a-b)+se*a+nw*b : ne*(a+b-1)+se*(1-b)+nw*(1-a);
    return this.ground.floorAt(x,z)+shift;
  }

  supportOffset(boot:BootPose,scale:number) {
    // Cache the supporting surface on touchdown, before this boot applies load.
    // The highest of six tread contacts supports a sole that only partly overlaps an old print.
    const sin=Math.sin(boot.yaw),cos=Math.cos(boot.yaw);
    let support=-Infinity;
    for(let i=-1;i<=1;i++) for(const side of [-1,1]) {
      const u=side*.045*scale,v=i*.112*scale;
      const x=boot.center.x+cos*u+sin*v,z=boot.center.z-sin*u+cos*v;
      support=Math.max(support,this.floorAt(x,z)-this.ground.floorAt(x,z));
    }
    return support;
  }

  deposit(x:number,z:number,volume:number) {
    // Spread loose material into a tapered shoulder. Kernel weights sum to one.
    const i=Math.round(x/spacing),j=Math.round(z/spacing);
    for(let b=-2;b<=2;b++) for(let a=-2;a<=2;a++) {
      this.change(i+a,j+b,volume/area*(3-Math.abs(a))*(3-Math.abs(b))/81);
    }
  }

  impact(x:number,z:number,diameter:number,normalSpeed:number,slideX:number,slideZ:number,dust:WalkDust) {
    // Approximate a hand-thrown stone as a sphere pressing into yielding soil.
    // Normal kinetic energy supplies the work to excavate a shallow paraboloid.
    const mass=2700*Math.PI/6*diameter**3;
    const volume=.5*mass*normalSpeed**2/18000;
    const depthLimit=diameter*.32;
    const depth=depthLimit*-Math.expm1(-Math.sqrt(2*volume/(Math.PI*diameter))/depthLimit);
    if (depth<.0002) return;
    const slide=Math.hypot(slideX,slideZ), dx=slide ? slideX/slide : 1, dz=slide ? slideZ/slide : 0;
    const stretch=1+.55*slide/(normalSpeed+slide);
    const width=Math.max(spacing*.88,Math.sqrt(diameter*depth)), length=width*stretch;
    let excavated=0;
    for(let j=Math.ceil((z-length)/spacing);j<=Math.floor((z+length)/spacing);j++) {
      for(let i=Math.ceil((x-length)/spacing);i<=Math.floor((x+length)/spacing);i++) {
        const rx=i*spacing-x,rz=j*spacing-z;
        const along=(rx*dx+rz*dz)/length, across=(rz*dx-rx*dz)/width;
        const cut=depth/stretch*(1-along*along-across*across);
        if(cut<=0) continue;
        this.change(i,j,-cut);
        excavated+=cut*area;
      }
    }
    if (!excavated) return;
    // Compaction consumes some of the volume; loose soil collects at the lip or flies out.
    const sectors=12, loose=excavated*.45/sectors;
    const phase=Math.random()*Math.PI*2, speed=Math.min(1.4,.32*normalSpeed);
    const count=Math.min(4,Math.ceil(loose*.10/3e-8));
    for(let k=0;k<sectors;k++) {
      const angle=phase+2*Math.PI*k/sectors, u=Math.cos(angle), v=Math.sin(angle);
      const rx=dx*u-dz*v,rz=dz*u+dx*v;
      const edgeX=x+1.12*(dx*u*length-dz*v*width),edgeZ=z+1.12*(dz*u*length+dx*v*width);
      let airborne=0;
      for(let n=0;n<count;n++) {
        airborne+=dust.launch(edgeX,edgeZ,rx+dx*(stretch-1),rz+dz*(stretch-1),
          speed*(.55+.65*Math.random()),loose*.10/count);
      }
      this.deposit(edgeX,edgeZ,loose-airborne);
    }
  }

  press(boot: BootPose, scale: number, dt: number, dust: WalkDust) {
    if (!dt || boot.loadedFor<0 || boot.settledFor>.24) return;
    const {center,across,along,up}=boot;
    const outsole=this.outsoles[boot.side===-1?0:1];
    const halfX=soleWidth*scale/2,halfZ=soleLength*scale/2;
    const ex=Math.abs(across.x)*halfX+Math.abs(along.x)*halfZ,ez=Math.abs(across.z)*halfX+Math.abs(along.z)*halfZ;
    const det=across.x*along.z-across.z*along.x;
    if (det<.2) return;
    this.displaced.fill(0);
    const flow=-Math.expm1(-dt*32);
    for(let j=Math.ceil((center.z-ez)/spacing);j<=(center.z+ez)/spacing;j++) {
      for(let i=Math.ceil((center.x-ex)/spacing);i<=(center.x+ex)/spacing;i++) {
        const x=i*spacing,z=j*spacing,dx=x-center.x,dz=z-center.z;
        const u=(dx*along.z-dz*along.x)/det/halfX, v=(dz*across.x-dx*across.z)/det/halfZ;
        const lug=outsole.sample(u*soleWidth/2,v*soleLength/2);
        if(lug>=.055) continue;
        const soleY=center.y-(up.x*dx+up.z*dz)/up.y+lug*scale/up.y;
        const cut=(this.ground.floorAt(x,z)+this.sample(i,j)-soleY)*flow;
        if(cut<.000025) continue;
        this.change(i,j,-cut);
        const angle=Math.atan2(v,u);
        const sector=(angle/(2*Math.PI)+1)*rimBins, bin=Math.floor(sector), f=sector-bin;
        this.displaced[bin%rimBins]+=cut*area*(1-f);
        this.displaced[(bin+1)%rimBins]+=cut*area*f;
      }
    }
    for(let i=0;i<rimBins;i++) {
      const moved=this.displaced[i]; if(!moved) continue;
      const [u,v,rx,rz]=outsole.rim[i];
      const dx=across.x*rx+along.x*rz, dz=across.z*rx+along.z*rz;
      const x=center.x+scale*(across.x*u+along.x*v)+dx*.012;
      const z=center.z+scale*(across.z*u+along.z*v)+dz*.012;
      // Most lost bulk volume is collapsed pore space. Shear drives the rest over the edge.
      const loose=moved*.16, speed=.12+.38*boot.impactSpeed;
      const airborne=dust.eject(x,z,dx,dz,speed,loose*.12);
      this.deposit(x,z,loose-airborne);
    }
  }

  private build(tile:SoilTile) {
    const n=row*row, p=new Float32Array(n*3), normal=new Float32Array(n*3);
    const uv=new Float32Array(n*2), alt=new Float32Array(n*3), colors=new Float32Array(n*3);
    tile.base=new Float32Array(n); tile.shade=new Float32Array(n);
    for(let z=0;z<row;z++) for(let x=0;x<row;x++) {
      const i=z*row+x,wx=tile.x*tileSize+x*spacing,wz=tile.z*tileSize+z*spacing;
      const a=this.appearance, y=this.ground.floorAt(wx,wz,a);
      p[i*3]=wx; p[i*3+1]=tile.base[i]=y; p[i*3+2]=wz;
      uv[i*2]=wx/4;uv[i*2+1]=wz/4;
      for(let k=0;k<3;k++){normal[i*3+k]=a[k];colors[i*3+k]=a[3];alt[i*3+k]=a[4+k];}
      tile.shade[i]=a[3];
    }
    tile.normals=normal.slice();
    const g=new BufferGeometry();
    g.setAttribute('position',attribute(p,3).setUsage(DynamicDrawUsage));
    g.setAttribute('normal',attribute(normal,3).setUsage(DynamicDrawUsage));
    g.setAttribute('color',attribute(colors,3).setUsage(DynamicDrawUsage));
    g.setAttribute('uv',attribute(uv,2));g.setAttribute('alternateSoilUV',attribute(alt,3));g.setIndex(levels[0]);
    g.computeBoundingSphere();g.boundingSphere!.radius+=.15;
    tile.mesh=new Mesh(g,this.material);tile.mesh.receiveShadow=true;this.group.add(tile.mesh);
    tile.dirty(0,0);tile.dirty(cells,cells);
  }

  private relax(tile:SoilTile) {
    // Loose material yields above its angle of repose; compacted tread walls retain cohesion.
    const minX=Math.max(0,tile.minX-1), maxX=Math.min(cells-1,tile.maxX+1);
    const minZ=Math.max(0,tile.minZ-1), maxZ=Math.min(cells-1,tile.maxZ+1);
    const base=tile.base!, d=tile.displacement;
    for(let z=minZ;z<=maxZ;z++) for(let x=minX;x<=maxX;x++) {
      const k=z*row+x;
      if(d[k]<.003)continue;
      const i=tile.x*cells+x,j=tile.z*cells+z;
      let lowest=base[k]+d[k],moveX=i,moveZ=j;
      for(let axis=0;axis<4;axis++) {
        const a=x+Number(axis===0)-Number(axis===1), b=z+Number(axis===2)-Number(axis===3);
        const inside=a>=0 && b>=0 && a<=cells && b<=cells;
        const h=inside ? d[b*row+a] : this.sample(tile.x*cells+a,tile.z*cells+b);
        if(h<-.001)continue;
        const y=h+(inside ? base[b*row+a] : this.ground.floorAt((tile.x*cells+a)*spacing,(tile.z*cells+b)*spacing));
        if(y<lowest){lowest=y;moveX=tile.x*cells+a;moveZ=tile.z*cells+b;}
      }
      const transfer=Math.min(d[k],(base[k]+d[k]-lowest-spacing*.65-.001)*.5);
      if(transfer>.0001) {this.change(i,j,-transfer);this.change(moveX,moveZ,transfer);}
    }
  }

  private flush(tile:SoilTile) {
    const g=tile.mesh!.geometry,p=g.getAttribute('position') as BufferAttribute;
    const n=g.getAttribute('normal') as BufferAttribute,c=g.getAttribute('color') as BufferAttribute;
    const x0=Math.max(0,tile.minX-1),x1=Math.min(cells,tile.maxX+1);
    const z0=Math.max(0,tile.minZ-1),z1=Math.min(cells,tile.maxZ+1);
    for(let z=z0;z<=z1;z++) for(let x=x0;x<=x1;x++) {
      const i=z*row+x, d=tile.displacement, norm=tile.normals!;
      const gx=(d[z*row+Math.min(cells,x+1)]-d[z*row+Math.max(0,x-1)])/((x===0||x===cells?1:2)*spacing);
      const gz=(d[Math.min(cells,z+1)*row+x]-d[Math.max(0,z-1)*row+x])/((z===0||z===cells?1:2)*spacing);
      p.setY(i,tile.base![i]+d[i]);
      n.setXYZ(i,norm[i*3]-gx*norm[3*i+1],norm[i*3+1],norm[i*3+2]-gz*norm[3*i+1]);
      const shade=tile.shade![i]*(1-Math.min(.15,Math.max(0,-d[i])*6));
      c.setXYZ(i,shade,shade,shade);
    }
    for(const attr of [p,n,c]) {
      attr.addUpdateRange((z0*row+x0)*3,((z1-z0)*row+x1-x0+1)*3);attr.needsUpdate=true;
    }
    tile.minX=tile.minZ=row;tile.maxX=tile.maxZ=-1;
  }

  // Absolute snapshots can be applied independently after packet loss, late joins or resizing.
  castTile(time:number,x:number,z:number): CastSoilTile | undefined {
    if(time < this.nextSend) return;
    this.nextSend = time + 90;
    let changed: SoilTile | undefined, refresh: SoilTile | undefined;
    let changedPriority = -Infinity, refreshPriority = -Infinity;
    for(const tile of this.visible) {
      const distance = Math.hypot((tile.x+.5)*tileSize-x,(tile.z+.5)*tileSize-z);
      const age = time - tile.lastSent;
      const priority = (Number.isFinite(age) ? age : 1e8) - 150*distance;
      if(tile.sentRevision !== tile.revision && priority > changedPriority) {
        changed = tile; changedPriority = priority;
      }
      if(age >= 1200 && priority > refreshPriority) {
        refresh = tile; refreshPriority = priority;
      }
    }
    const tile = this.transmissions % 4 === 3 ? refresh ?? changed : changed ?? refresh;
    if(!tile) return;
    this.transmissions++;
    tile.lastSent=time; tile.sentRevision=tile.revision;
    return {x:tile.x,z:tile.z,revision:tile.revision,heights:encodeSoil(tile.displacement)};
  }

  applyCastTile(snapshot:CastSoilTile) {
    const existing=this.tiles.get(key(snapshot.x,snapshot.z));
    if(existing && existing.revision >= snapshot.revision) return;
    const heights=decodeSoil(snapshot.heights);
    if(!heights) return;
    const tile=existing ?? this.tile(snapshot.x,snapshot.z);
    tile.displacement.set(heights); tile.revision=snapshot.revision;
    tile.dirty(0,0); tile.dirty(cells,cells);
  }

  update(x:number,z:number,simulate=true) {
    const ox=Math.floor(x/tileSize)-span/2,oz=Math.floor(z/tileSize)-span/2;
    if(this.maskDirty || ox!==this.origin.x || oz!==this.origin.y) {
      this.origin.set(ox,oz);this.pixels.fill(0);
      for(const t of this.visible) if(t.x<ox||t.z<oz||t.x>=ox+span||t.z>=oz+span) {t.release();this.visible.delete(t);}
      // A lookup stays bounded even after a long traverse.
      for(let j=0;j<span;j++) for(let i=0;i<span;i++) {
        const t=this.tiles.get(key(ox+i,oz+j));if(!t)continue;
        this.pixels[j*span+i]=255;
        if(!this.visible.has(t)){this.build(t);this.visible.add(t);}
      }
      this.mask.needsUpdate=true;this.maskDirty=false;
    }
    for(const t of this.visible) {
      const d=Math.max(Math.abs((t.x+.5)*tileSize-x),Math.abs((t.z+.5)*tileSize-z));
      const index=levels[d<2.5?0:d<6?1:2];
      if(t.mesh!.geometry.index!==index)t.mesh!.geometry.setIndex(index);
      if(t.maxX>=0){if(simulate)this.relax(t);this.flush(t);}
    }
  }

  rebuildSurface() {
    for (const t of this.visible) t.release();
    this.visible.clear();
    this.maskDirty=true;
  }

  takeTrail() {
    this.rebuildSurface();
    return new Map(this.tiles);
  }

  restoreTrail(stored: ReturnType<WalkFootprints['takeTrail']>) {
    for(const [key,tile] of stored)this.tiles.set(key,tile);
    this.maskDirty=true;
  }

  dispose() {
    for(const t of this.visible)t.release();
    this.visible.clear();this.tiles.clear();this.material.dispose();this.mask.dispose();
  }
}
