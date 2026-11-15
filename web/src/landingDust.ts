import {
  BackSide, Data3DTexture, DynamicDrawUsage, Float32BufferAttribute, InstancedBufferAttribute, InstancedBufferGeometry, LinearFilter,
  MathUtils, Mesh, Quaternion, RedFormat, RepeatWrapping, ShaderMaterial, Vector3,
} from 'three';
import { LandingBed } from './landerDynamics';
import { lunarGravity } from './walkGait';

const capacity = 3072;
const gravityTerm = lunarGravity / 2;
const maxFlight = 4;

// Each box bounds a moving ellipsoid. Integrate its far and near halves separately so
// terrain and spacecraft depth can occlude the back of a packet that straddles a surface.
function volumeGeometry() {
  const corners = [-1,-1,-1, 1,-1,-1, 1,1,-1, -1,1,-1, -1,-1,1, 1,-1,1, 1,1,1, -1,1,1];
  const faces = [0,2,1, 0,3,2, 4,5,6, 4,6,7, 0,4,7, 0,7,3, 1,2,6, 1,6,5, 0,1,5, 0,5,4, 3,7,6, 3,6,2];
  const geometry = new InstancedBufferGeometry();
  geometry.setIndex([...faces,...faces.map(i => i+8)]);
  geometry.setAttribute('position',new Float32BufferAttribute([...corners,...corners],3));
  geometry.setAttribute('nearHalf',new Float32BufferAttribute([0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1],1));
  return geometry;
}

const vertexShader = `
  attribute vec4 launch, flight, appearance;
  attribute float nearHalf;
  uniform float clock;
  uniform vec3 sunlight;
  varying vec3 boxPoint;
  flat varying vec3 eyeLocal, radii, sunLocal;
  flat varying vec4 viewDepth;
  flat varying vec3 style;
  flat varying float frontHalf;

  void main() {
    float age = clock - launch.w;
    bool grit = appearance.z > .5;
    if (age < 0. || age >= flight.w || (grit && nearHalf < .5)) {
      gl_Position = vec4(2.,2.,2.,1.);
      return;
    }
    vec3 centre = launch.xyz + flight.xyz * age;
    centre.y -= ${gravityTerm} * age * age;
    vec2 heading = normalize(flight.xz);
    mat3 basis = mat3(vec3(heading.x,0.,heading.y), vec3(0.,1.,0.), vec3(-heading.y,0.,heading.x));
    radii = appearance.x * (grit ? vec3(.034,.018,.023) :
      vec3(.80 + 3.6*age, .17 + .48*age, .40 + 1.25*age));
    mat3 axes = mat3(modelViewMatrix) * basis;
    vec3 centreView = (modelViewMatrix * vec4(centre,1.)).xyz;
    eyeLocal = transpose(axes) * -centreView / radii;
    sunLocal = transpose(basis) * sunlight;
    viewDepth = vec4(vec3(axes[0].z,axes[1].z,axes[2].z)*radii, centreView.z);
    float fade = smoothstep(0.,.065,age) * smoothstep(0.,.15,flight.w-age);
    // Expansion dilutes airborne fines; solid grit keeps its silhouette until impact.
    float dilution = grit ? 1. : pow(1. + age*1.55, 2.4);
    style = vec3(appearance.y * fade / dilution, appearance.w, appearance.z);
    boxPoint = position;
    frontHalf = nearHalf;
    gl_Position = projectionMatrix * vec4(centreView + axes*(position*radii),1.);
  }`;

const fragmentShader = `
  uniform highp sampler3D noiseMap;
  uniform mat4 projectionMatrix;
  uniform float daylight;
  varying vec3 boxPoint;
  flat varying vec3 eyeLocal, radii, sunLocal;
  flat varying vec4 viewDepth;
  flat varying vec3 style;
  flat varying float frontHalf;

  void main() {
    // Work from a point on the proxy, avoiding cancellation when the observer is far away.
    vec3 ray = normalize(boxPoint-eyeLocal);
    vec3 closest = boxPoint - ray*dot(boxPoint,ray);
    float chordSq = 1. - dot(closest,closest);
    if (chordSq <= 0.) discard;
    float end = sqrt(chordSq);
    float start = max(-end,dot(eyeLocal-closest,ray));
    if (start >= end) discard;

    vec3 depthPoint;
    vec3 color;
    float alpha;
    if (style.z > .5) {
      depthPoint = closest + start*ray;
      vec3 normal = normalize(depthPoint / radii);
      color = vec3(.34,.32,.30)*(.07 + daylight*(.18+.93*max(0.,dot(normal,sunLocal))));
      alpha = style.x;
    } else {
      float middle = .5*(start+end);
      if (frontHalf > .5) end = middle; else start = middle;
      float stepLength = (end-start)/3.;
      float metresPerStep = stepLength * length(ray*radii);
      vec3 offset = style.y * vec3(.61,.83,.47);
      vec3 sunRay = normalize(sunLocal/radii);
      float sunScale = length(sunRay*radii);
      float scattering = .70 + .30*pow(max(0.,dot(normalize(ray*radii),sunLocal)),3.);
      float transmission = 1.;
      float light = 0., weightedDepth = 0.;
      for (int i=0; i<3; i++) {
        float t = start + (float(i)+.5)*stepLength;
        vec3 point = closest + ray*t;
        vec3 uvw = point*vec3(.084,.10,.115) + offset;
        float noise = .72*texture(noiseMap,uvw).r + .28*texture(noiseMap,uvw*2.35).r;
        float envelope = max(0.,1.-dot(point,point));
        float density = max(0.,envelope - .27*(1.-noise))*smoothstep(.20,.80,noise);
        float absorbed = transmission * (1.-exp(-2.0*style.x*density*metresPerStep));
        float projected = dot(point,sunRay);
        float sunPath = (sqrt(projected*projected+envelope)-projected)*sunScale;
        float lit = exp(-1.6*sunPath*style.x*(.35+density));
        light += absorbed * (.055 + daylight*(.16 + .98*lit*scattering));
        weightedDepth += absorbed*t;
        transmission -= absorbed;
      }
      alpha = 1.-transmission;
      if (alpha < .003) discard;
      depthPoint = closest + ray*(weightedDepth/alpha);
      color = vec3(.48,.46,.43)*light/alpha;
    }
    if (alpha < .003) discard;
    float z = dot(viewDepth.xyz,depthPoint) + viewDepth.w;
    float ndc = (projectionMatrix[2][2]*z + projectionMatrix[3][2]) / -z;
    if (ndc < -1. || ndc > 1.) discard;
    gl_FragDepth = .5*ndc+.5;
    gl_FragColor = vec4(color,alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

function particleAttribute() {
  return new InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(DynamicDrawUsage);
}

export class LandingDust {
  private geometry = volumeGeometry();
  private launch = particleAttribute();
  private flight = particleAttribute();
  private appearance = particleAttribute();
  private noise = new Data3DTexture(new Uint8Array(32**3),32,32,32);
  private material = new ShaderMaterial({
    uniforms: {clock:{value:0}, daylight:{value:1}, sunlight:{value:new Vector3()}, noiseMap:{value:this.noise}},
    vertexShader, fragmentShader, side:BackSide, transparent:true, depthWrite:false,
  });
  readonly mesh = new Mesh(this.geometry,this.material);
  private bed: LandingBed;
  private normal = new Vector3();
  private axis = new Vector3();
  private bell = new Vector3();
  private clock = 0;
  private clearAt = 0;
  private bursts = 0;
  private next = 0;

  constructor(private surface:(x:number,z:number)=>number) {
    this.bed = new LandingBed(surface, 1.5);
    const pixels = this.noise.image.data as Uint8Array;
    for (let i=0; i<pixels.length; i++) pixels[i] = Math.random()*256;
    this.noise.format = RedFormat;
    this.noise.wrapS = this.noise.wrapT = this.noise.wrapR = RepeatWrapping;
    this.noise.magFilter = this.noise.minFilter = LinearFilter;
    this.noise.needsUpdate = true;
    this.geometry.setAttribute('launch',this.launch);
    this.geometry.setAttribute('flight',this.flight);
    this.geometry.setAttribute('appearance',this.appearance);
    this.geometry.instanceCount = 0;
    this.mesh.name = 'Engine-ejected lunar soil';
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  reset() {
    this.bed = new LandingBed(this.surface, 1.5);
    this.clock = this.clearAt = this.bursts = this.next = 0;
    this.geometry.instanceCount = 0;
    this.mesh.visible = false;
  }

  update(dt:number, origin:Vector3, attitude:Quaternion, height:number, thrust:number, sun:Vector3) {
    this.clock += dt;
    this.material.uniforms.clock.value = this.clock;
    this.material.uniforms.daylight.value = MathUtils.smoothstep(sun.y,-.045,.26);
    this.material.uniforms.sunlight.value.copy(sun);
    const erosion = thrust * (1 - MathUtils.smoothstep(height,1,30));
    if (erosion > 0 && dt > 0) {
      // Trace the tilted engine axis from the nozzle lip to the local surface.
      this.bell.set(0,.38,0).applyQuaternion(attitude).add(origin);
      this.axis.set(0,-1,0).applyQuaternion(attitude);
      let distance = Math.max(0,height+.38);
      for (let i=0; i<2; i++) {
        const y = this.bed.at(this.bell.x+distance*this.axis.x, this.bell.z+distance*this.axis.z);
        distance = Math.max(0,(this.bell.y-y)/Math.max(.1,-this.axis.y));
      }
      this.bell.addScaledVector(this.axis,distance);
      const rate = 118 * erosion;
      this.bursts += dt * rate;
      const before = this.next;
      while (this.bursts >= 1) {
        this.bursts--;
        const birth = this.clock - this.bursts/rate;
        const heading = Math.random()*2*Math.PI;
        // Neighbouring grains leave the same patch in a fan, forming irregular radial streaks.
        for (let i=0; i<4; i++) this.emit(heading, birth, distance, erosion, i===3);
      }
      if (this.next !== before) {
        for (const attribute of [this.launch,this.flight,this.appearance]) {
          if (this.next > before) attribute.addUpdateRange(before*4,(this.next-before)*4);
          else {
            attribute.addUpdateRange(before*4,(capacity-before)*4);
            if (this.next) attribute.addUpdateRange(0,this.next*4);
          }
          attribute.needsUpdate = true;
        }
      }
    }
    this.mesh.visible = this.clock < this.clearAt;
  }

  private emit(heading:number, birth:number, height:number, erosion:number, grit:boolean) {
    const angle = heading + (Math.random()-.5)*.28;
    const dx = Math.cos(angle), dz = Math.sin(angle);
    const radius = (.65+height*.115) * (.7+Math.random()*.9);
    const x = this.bell.x + radius*dx, z = this.bell.z + radius*dz;
    const y = this.bed.at(x,z,this.normal) + .035;
    const speed = (grit ? 3+Math.random()*6 : 15+Math.random()*22) * (.75+.25*erosion);
    const grade = -(dx*this.normal.x + dz*this.normal.z)/this.normal.y;
    const lift = grit ? .12+Math.random()*.20 : .023+Math.random()*.036;
    const vx = dx*speed, vy = speed*(grade+lift), vz = dz*speed;
    // Resolve flight against the local relief once at launch; the GPU evaluates the arc in both eyes.
    const step = Math.min(.14,1.5/speed);
    let life = maxFlight;
    for (let t=step; t<=maxFlight; t+=step) {
      const clearance = y+vy*t-gravityTerm*t*t - this.bed.at(x+vx*t,z+vz*t);
      if (clearance<=0) {
        let low = t-step, high = t;
        for (let i=0; i<7; i++) {
          const mid = (low+high)*.5;
          if (y+vy*mid-gravityTerm*mid*mid > this.bed.at(x+vx*mid,z+vz*mid)) low = mid;
          else high = mid;
        }
        life = (low+high)*.5;
        break;
      }
    }
    const i = this.next;
    this.launch.setXYZW(i,x,y,z,birth);
    this.flight.setXYZW(i,vx,vy,vz,life);
    this.appearance.setXYZW(i,.8+Math.random()*1.05,grit ? .85 : .32+.34*Math.random(),Number(grit),Math.random()*16);
    this.clearAt = Math.max(this.clearAt,birth+life);
    this.geometry.instanceCount = Math.max(this.geometry.instanceCount,i+1);
    this.next = (i+1)%capacity;
  }

  dispose() {
    this.noise.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
