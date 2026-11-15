import {
  DataTexture, DynamicDrawUsage, Float32BufferAttribute, InstancedBufferAttribute, InstancedBufferGeometry, LinearFilter,
  MathUtils, Mesh, Quaternion, RedFormat, RepeatWrapping, ShaderMaterial, Vector3,
} from 'three';
import { LandingBed } from './landerDynamics';
import { lunarGravity } from './walkGait';

const capacity = 3072;
const gravityTerm = lunarGravity / 2;
const maxFlight = 4;

// Each instance represents a packet of grains with slightly different launch velocities.
// Its footprint grows with flight time. Project its three physical axes separately in each eye.
const vertexShader = `
  attribute vec4 launch, flight, appearance;
  uniform float clock;
  varying vec2 patchUV;
  varying vec3 dustStyle;
  void main() {
    float age = clock - launch.w;
    if (age < 0. || age >= flight.w) {
      gl_Position = vec4(2., 2., 2., 1.);
      return;
    }
    vec3 centre = launch.xyz + flight.xyz * age;
    centre.y -= ${gravityTerm} * age * age;
    vec2 heading = normalize(flight.xz);
    bool grit = appearance.z > .5;
    float spread = appearance.x;
    vec3 size = grit ? vec3(.027, .014, .012) * spread :
      vec3(.88 + age * 4.1, .45 + age * 1.55, .085 + age * .30) * spread;
    mat3 view = mat3(modelViewMatrix);
    vec3 along = view * vec3(heading.x, 0., heading.y) * size.x;
    vec3 across = view * vec3(-heading.y, 0., heading.x) * size.y;
    vec3 up = view * vec3(0., 1., 0.) * size.z;
    // Screen-space ellipse of the projected ellipsoid, with texture aligned to the flow.
    vec2 axis = along.xy / max(length(along.xy), .00001);
    if (dot(axis,axis) < .5) axis = vec2(1.,0.);
    vec2 side = vec2(-axis.y,axis.x);
    vec3 a = vec3(dot(along.xy,axis), dot(across.xy,axis), dot(up.xy,axis));
    vec3 b = vec3(dot(along.xy,side), dot(across.xy,side), dot(up.xy,side));
    float lengthA = max(length(a), .00001);
    float skew = dot(a,b) / lengthA;
    float lengthB = sqrt(max(dot(b,b)-skew*skew,.000001));
    vec2 quad = position.xy;
    vec4 point = modelViewMatrix * vec4(centre, 1.);
    point.xy += axis * (lengthA * quad.x) + side * (skew * quad.x + lengthB * quad.y);
    // Give the sheet its true depth across the quad, including at grazing angles near the soil.
    vec3 depth = vec3(along.z,across.z,up.z);
    float depthA = dot(depth,a)/lengthA;
    float depthB = (dot(depth,b)-skew*depthA)/lengthB;
    point.z += depthA*quad.x + depthB*quad.y;
    gl_Position = projectionMatrix * point;
    float fade = smoothstep(0., .065, age) * smoothstep(0., .15, flight.w-age);
    dustStyle = vec3(appearance.y * fade / (1. + age * .95), appearance.w, appearance.z);
    patchUV = quad;
  }`;

const fragmentShader = `
  uniform sampler2D noiseMap;
  uniform float daylight;
  varying vec2 patchUV;
  varying vec3 dustStyle;
  void main() {
    float envelope = max(0., 1. - dot(patchUV,patchUV));
    vec2 uv = patchUV * vec2(.095,.075) + vec2(dustStyle.y, dustStyle.y*.73);
    float noise = texture2D(noiseMap, uv).r * .7 + texture2D(noiseMap, uv*3.1).r * .3;
    float density = mix((.24 + .76*smoothstep(.15,.84,noise)) * envelope * envelope, envelope, dustStyle.z);
    float alpha = dustStyle.x * density;
    if (alpha < .003) discard;
    vec3 soil = vec3(.47,.45,.42) * mix(.10,1.,daylight) * (.78 + .35*noise);
    gl_FragColor = vec4(soil,alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

function particleAttribute() {
  return new InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(DynamicDrawUsage);
}

export class LandingDust {
  private geometry = new InstancedBufferGeometry();
  private launch = particleAttribute();
  private flight = particleAttribute();
  private appearance = particleAttribute();
  private noise = new DataTexture(new Uint8Array(64*64),64,64,RedFormat);
  private material = new ShaderMaterial({
    uniforms: {clock:{value:0}, daylight:{value:1}, noiseMap:{value:this.noise}},
    vertexShader, fragmentShader, transparent:true, depthWrite:false,
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
    this.noise.wrapS = this.noise.wrapT = RepeatWrapping;
    this.noise.magFilter = this.noise.minFilter = LinearFilter;
    this.noise.needsUpdate = true;
    this.geometry.setIndex([0,1,2,0,2,3]);
    this.geometry.setAttribute('position', new Float32BufferAttribute([-1,-1,0, 1,-1,0, 1,1,0, -1,1,0],3));
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

  update(dt:number, origin:Vector3, attitude:Quaternion, height:number, thrust:number, sunY:number) {
    this.clock += dt;
    this.material.uniforms.clock.value = this.clock;
    this.material.uniforms.daylight.value = MathUtils.smoothstep(sunY,-.045,.26);
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
