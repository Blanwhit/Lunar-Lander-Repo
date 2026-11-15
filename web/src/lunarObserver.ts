import { MathUtils, Matrix4, Mesh, Quaternion, ShaderMaterial, SphereGeometry, Texture, Vector3 } from 'three';
import { R_MOON, type Vec3 } from './geom';

const up = new Vector3(0, 1, 0);
const right = new Vector3(1, 0, 0);

/** The outside view belongs to the observer. Flight time and vehicle poses never enter it. */
export class LunarObserver {
  readonly eye = new Vector3();
  readonly rotation = new Quaternion();
  readonly centre = new Vector3();
  private frame = new Quaternion();
  private offset = new Vector3();
  private tangent = new Vector3();
  private normal = new Vector3();
  private axis = new Vector3();
  private turn = new Quaternion();
  private pitchRotation = new Quaternion();
  private pivot = new Vector3();
  private range = 19;
  private yaw = 2.62;
  private pitch = .16;
  private floor!: (x: number, z: number) => number;

  reset(x: number, z: number, originElevation: number, floor: (x: number, z: number) => number) {
    this.floor = floor;
    this.centre.set(0, -R_MOON-originElevation, 0);
    this.normal.set(x, floor(x,z), z).sub(this.centre).normalize();
    this.frame.setFromUnitVectors(up, this.normal);
    this.range = 19; this.yaw = 2.62; this.pitch = .16;
    this.update();
  }
  orbit(dx: number, dy: number) {
    if (!dx && !dy) return;
    if (this.range >= 200000) {
      this.pan(dx, -dy);
      return;
    }
    this.yaw += dx;
    this.pitch = MathUtils.clamp(this.pitch+dy, -.24, Math.PI/2-.01);
    this.update();
  }
  pan(x: number, y: number) {
    if (!x && !y) return;
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    this.tangent.set(c*x-s*y, 0, -s*x-c*y).applyQuaternion(this.frame);
    const angle = Math.min(this.tangent.length()*this.range/R_MOON, .5);
    this.normal.copy(up).applyQuaternion(this.frame);
    this.axis.crossVectors(this.normal, this.tangent.normalize()).normalize();
    this.frame.premultiply(this.turn.setFromAxisAngle(this.axis, angle)).normalize();
    this.update();
  }
  dolly(delta: number) {
    if (!delta) return;
    this.range = MathUtils.clamp(this.range*Math.exp(delta), 1.3, 5*R_MOON);
    this.update();
  }
  get orbital() {
    return this.range > 240000 || this.normal.y < .95;
  }
  private update() {
    this.normal.copy(up).applyQuaternion(this.frame);
    this.pivot.copy(this.normal).multiplyScalar(-this.centre.y).add(this.centre);
    // Match the actual rendered terrain near the landing. Distant regions use the orbital mesh.
    const local = this.normal.y >= .95;
    if (local) this.pivot.y = this.floor(this.pivot.x,this.pivot.z);
    else this.range = Math.max(this.range, 32000);
    this.pivot.addScaledVector(this.normal, 4.2);
    const tilt = MathUtils.lerp(this.pitch, Math.PI/2, MathUtils.smoothstep(this.range, 8000, R_MOON));
    this.offset.set(Math.sin(this.yaw)*Math.cos(tilt), Math.sin(tilt), Math.cos(this.yaw)*Math.cos(tilt))
      .applyQuaternion(this.frame);
    this.eye.copy(this.pivot).addScaledVector(this.offset,this.range);
    if (local && this.range < 240000) this.eye.y = Math.max(this.eye.y, this.floor(this.eye.x,this.eye.z)+.6);
    this.offset.copy(this.eye).sub(this.pivot).applyQuaternion(this.turn.copy(this.frame).invert());
    this.rotation.copy(this.frame).multiply(this.turn.setFromAxisAngle(up,this.yaw))
      .multiply(this.pitchRotation.setFromAxisAngle(right,-Math.atan2(this.offset.y,Math.hypot(this.offset.x,this.offset.z))));
  }
}

/** Render the planet as a distant background at reduced scale to preserve depth precision in XR. */
export function orbitalMoon(map: Texture, elevation: (direction: Vec3) => number) {
  const geometry = new SphereGeometry(1, 240, 120);
  const positions = geometry.getAttribute('position');
  const dir: Vec3 = [0,0,0];
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i), y = positions.getY(i), z = positions.getZ(i);
    dir[0]=x; dir[1]=-z; dir[2]=y;
    const radius = (R_MOON + elevation(dir))/256;
    positions.setXYZ(i,x*radius,y*radius,z*radius);
  }
  geometry.computeVertexNormals();
  const material = new ShaderMaterial({
    uniforms: { albedo: {value: map}, sunlight: {value: new Vector3()} },
    vertexShader: `varying vec2 st; varying vec3 n;
      void main(){st=uv;n=normal;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader: `uniform sampler2D albedo; uniform vec3 sunlight; varying vec2 st; varying vec3 n;
      void main(){float light=.065+1.5*max(0.,dot(normalize(n),sunlight));
      gl_FragColor=vec4(texture2D(albedo,st).rgb*light,1.);
      #include <colorspace_fragment>
      }`,
  });
  const mesh = new Mesh(geometry, material);
  const bodyOrientation = new Matrix4().makeRotationX(Math.PI/2);
  return {
    mesh,
    align(landingToBody: Matrix4, sun: Vector3) {
      mesh.quaternion.setFromRotationMatrix(landingToBody.clone().transpose().multiply(bodyOrientation));
      material.uniforms.sunlight.value.copy(sun).applyQuaternion(mesh.quaternion.clone().invert());
    },
    place(centre: Vector3, eye: Vector3) {
      mesh.position.copy(centre).sub(eye).multiplyScalar(1/256).add(eye);
    },
    dispose() { mesh.removeFromParent(); geometry.dispose(); material.dispose(); },
  };
}
