import {
  DataArrayTexture, LinearFilter, Material, RGFormat, type DataTexture,
} from 'three';
import { dirToFace, type Vec3 } from '../geom';
import type { FeasibilityOverlay } from './FeasibilityOverlay';

// A handheld globe uses the first subdivided level (128 samples across each face).
// The same ancestor tile and bilinear sampling are used for the tint and the readout.
export class VrFeasibility {
  readonly level: number;

  private readonly atlas: DataArrayTexture;
  private readonly layers: { level:number; face:number; x:number; y:number; source?:DataTexture; version:number }[] = [];
  private readonly visible = {value:false};
  private readonly tintStrength = {value:0.72};
  private nextRefresh = 0;

  constructor(readonly overlay: FeasibilityOverlay, readonly toggle: () => void) {
    this.level = Math.min(1, overlay.meta.maxLevel);
    for (let level=0; level<=this.level; level++) {
      const count=1<<level;
      for(let face=0;face<6;face++) for(let y=0;y<count;y++) for(let x=0;x<count;x++){
        this.layers.push({level,face,x,y,version:-1});
      }
    }
    const size=overlay.meta.samples;
    this.atlas=new DataArrayTexture(new Uint8Array(size*size*2*this.layers.length),size,size,this.layers.length);
    this.atlas.format=RGFormat;
    this.atlas.magFilter=this.atlas.minFilter=LinearFilter;
    this.atlas.needsUpdate=true;
  }

  /** One score sampler for the picking globe, the orbital Moon and the rendered soil. */
  applyTo(material: Material, bodyDirection: string) {
    const compile=material.onBeforeCompile;
    material.onBeforeCompile=(shader,renderer)=>{
      compile.call(material,shader,renderer);
      shader.uniforms.vrScoreAtlas={value:this.atlas};
      shader.uniforms.vrHeatEnabled=this.visible;
      shader.uniforms.vrHeatStrength=this.tintStrength;
      shader.vertexShader='varying vec3 vScoreDirection;\n'+shader.vertexShader.replace('#include <begin_vertex>',
        '#include <begin_vertex>\n vScoreDirection='+bodyDirection+';');
      shader.fragmentShader=heatmapShader(this.overlay.meta.samples,this.level)+shader.fragmentShader.replace(
        '#include <colorspace_fragment>',
        'if(vrHeatEnabled) gl_FragColor.rgb=feasibilityTint(gl_FragColor.rgb,vScoreDirection);\n#include <colorspace_fragment>');
    };
  }

  update(time:number, immersive:boolean) {
    this.tintStrength.value=immersive ? 0.55 : 0.72;
    this.visible.value=this.overlay.enabled;
    if(!this.visible.value){this.nextRefresh=0;return;}
    if(time<this.nextRefresh)return;
    this.nextRefresh=time+100;
    const size=this.overlay.meta.samples, area=size*size;
    const pixels=this.atlas.image.data as Uint8Array;
    let changed=false;
    for(const [index,layer] of this.layers.entries()){
      const tile=this.overlay.lookup(layer.level,layer.face,layer.x,layer.y,true);
      // Store each tile at its native resolution. The shader falls back to the root when needed.
      const source=tile?.scale===1?tile.tex:undefined;
      if(layer.source===source && layer.version===(source?.version??-1))continue;
      layer.source=source;layer.version=source?.version??-1;
      const offset=index*area*2;
      if(source){
        const scores=source.image.data as Uint8Array;
        for(let i=0;i<area;i++){pixels[offset+2*i]=scores[i];pixels[offset+2*i+1]=255;}
      }else pixels.fill(0,offset,offset+area*2);
      changed=true;
    }
    this.overlay.endFrame();
    if(changed)this.atlas.needsUpdate=true;
  }

  reading(direction: Vec3, label = 'Feasibility') {
    const { face, a, b } = dirToFace(direction);
    const n = 1 << this.level;
    const u = Math.max(0, Math.min(n, (a + 1) * n / 2));
    const v = Math.max(0, Math.min(n, (b + 1) * n / 2));
    const x = Math.min(n - 1, Math.floor(u)), y = Math.min(n - 1, Math.floor(v));
    const tile = this.overlay.lookup(this.level, face, x, y, true);
    this.overlay.endFrame();
    if (!tile) return this.overlay.unavailable(face) ? 'Feasibility unavailable' : 'Loading feasibility…';
    const { data, width } = tile.tex.image;
    const fx = (tile.ou + (u - x) * tile.scale) * (width - 1);
    const fy = (tile.ov + (v - y) * tile.scale) * (width - 1);
    const i = Math.min(width - 2, Math.floor(fx)), j = Math.min(width - 2, Math.floor(fy));
    const offset = j * width + i, dx = fx - i, dy = fy - j;
    const bytes = data as Uint8Array;
    const low = bytes[offset] * (1-dx) + bytes[offset+1] * dx;
    const high = bytes[offset+width] * (1-dx) + bytes[offset+width+1] * dx;
    return label + ' ' + Math.round((low*(1-dy) + high*dy) * 100 / 255) + '%';
  }
}

// Match geom.dirToFace and the worker's texel-centred, equi-angular score grid.
function heatmapShader(samples:number,level:number){
  return `
    varying vec3 vScoreDirection;
    uniform highp sampler2DArray vrScoreAtlas;
    uniform bool vrHeatEnabled;
    uniform float vrHeatStrength;
    vec2 scoreLayer(vec2 uv, float layer){
      return texture(vrScoreAtlas,vec3((uv*${(samples-1).toFixed(1)}+.5)/${samples.toFixed(1)},layer)).rg;
    }
    vec3 feasibilityTint(vec3 base,vec3 d){
      vec3 a=abs(d);
      vec2 uv;float face;
      if(a.x>=a.y && a.x>=a.z){
        face=d.x>=0.?0.:1.;uv=vec2(d.x>=0.?d.y:-d.y,d.z)/a.x;
      }else if(a.y>=a.z){
        face=d.y>=0.?2.:3.;uv=vec2(d.y>=0.?-d.x:d.x,d.z)/a.y;
      }else{
        face=d.z>=0.?4.:5.;uv=vec2(d.y,d.z>=0.?-d.x:d.x)/a.z;
      }
      uv=clamp(.5+atan(uv)*.6366197724,0.,1.);
      vec2 sc;
      ${level>0?`vec2 cell=min(floor(uv*2.),vec2(1.));
        sc=scoreLayer(uv*2.-cell,6.+4.*face+2.*cell.y+cell.x);
        if(sc.g<.5)sc=scoreLayer(uv,face);`:'sc=scoreLayer(uv,face);'}
      if(sc.g<.5)return base;
      vec3 red=vec3(.86,.12,.09),yellow=vec3(.98,.84,.16),green=vec3(.13,.70,.27);
      vec3 ramp=sc.r<.5?mix(red,yellow,2.*sc.r):mix(yellow,green,2.*sc.r-1.);
      return mix(base,pow(ramp,vec3(2.2)),vrHeatStrength);
    }
  `;
}
