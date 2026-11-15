import { type BufferGeometry, Vector3 } from 'three';

export const soleWidth = .17260, soleLength = .33443;
export const restSole = (side: number) => new Vector3(side * .16505,0,.08887);
const nx=48, nz=88, air=.060;
const borderX=soleWidth*.58, borderZ=soleLength*.56;
export const rimBins=48;

/** Rasterize the underside of the actual boot once, so the collision surface includes its tread. */
export class WalkOutsole {
  private readonly height = new Float32Array(nx*nz).fill(air);
  readonly rim: number[][] = [];
  constructor(geometry:BufferGeometry,side:number) {
    const p=geometry.getAttribute('position'), idx=geometry.index!;
    const origin=restSole(side), sx=(nx-1)/(2*borderX), sz=(nz-1)/(2*borderZ);
    for (let i=0;i<idx.count;i+=3) {
      const a=idx.getX(i),b=idx.getX(i+1),c=idx.getX(i+2);
      const ay=p.getY(a),by=p.getY(b),cy=p.getY(c);
      if (Math.min(ay,by,cy)>air || p.getX(a)*side<0) continue;
      const ax=(p.getX(a)-origin.x+borderX)*sx,az=(p.getZ(a)-origin.z+borderZ)*sz;
      const bx=(p.getX(b)-origin.x+borderX)*sx,bz=(p.getZ(b)-origin.z+borderZ)*sz;
      const cx=(p.getX(c)-origin.x+borderX)*sx,cz=(p.getZ(c)-origin.z+borderZ)*sz;
      const det=(bx-ax)*(cz-az)-(bz-az)*(cx-ax);
      if (Math.abs(det)<.00001) continue;
      const minX=Math.max(0,Math.ceil(Math.min(ax,bx,cx))),maxX=Math.min(nx-1,Math.floor(Math.max(ax,bx,cx)));
      const minZ=Math.max(0,Math.ceil(Math.min(az,bz,cz))),maxZ=Math.min(nz-1,Math.floor(Math.max(az,bz,cz)));
      for(let z=minZ;z<=maxZ;z++) for(let x=minX;x<=maxX;x++) {
        const wb=((x-ax)*(cz-az)-(z-az)*(cx-ax))/det;
        const wc=((bx-ax)*(z-az)-(bz-az)*(x-ax))/det;
        if(wb<0 || wc<0 || wb+wc>1)continue;
        const k=z*nx+x;
        this.height[k]=Math.min(this.height[k],ay+wb*(by-ay)+wc*(cy-ay));
      }
    }
    for(let i=0;i<rimBins;i++) {
      const angle=2*Math.PI*i/rimBins,rx=Math.cos(angle),rz=Math.sin(angle);
      let limit=0;
      for(let r=0;r<=1.6;r+=.0125) if(this.sample(rx*r*soleWidth/2,rz*r*soleLength/2)<.014)limit=r;
      this.rim.push([rx*limit*soleWidth/2,rz*limit*soleLength/2,rx,rz]);
    }
  }

  sample(x:number,z:number) {
    const u=(x/borderX+1)*(nx-1)/2,v=(z/borderZ+1)*(nz-1)/2;
    if(u<0 || v<0 || u>=nx-1 || v>=nz-1)return air;
    const i=Math.floor(u),j=Math.floor(v),a=u-i,b=v-j,k=j*nx+i,h=this.height;
    return (h[k]*(1-a)+h[k+1]*a)*(1-b)+(h[k+nx]*(1-a)+h[k+nx+1]*a)*b;
  }
}
