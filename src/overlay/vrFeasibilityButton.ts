import { CanvasTexture, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry, Ray, SRGBColorSpace } from 'three';
import type { VrFeasibility } from './vrFeasibility';

const width = .44, height = .088;

/** A stereo HUD button. The mesh and the controller hit test use the same XR reference space. */
export class VrFeasibilityButton {
  readonly mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly canvas = document.createElement('canvas');
  private readonly texture: CanvasTexture;
  private readonly inverse = new Matrix4();
  private readonly ray = new Ray();
  private previousSource?: XRInputSource;
  private pressed = false;
  private lastState = '';

  constructor(private scores: VrFeasibility) {
    this.canvas.width = 600;
    this.canvas.height = 120;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.mesh = new Mesh(new PlaneGeometry(width, height), new MeshBasicMaterial({
      map: this.texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
    }));
    this.mesh.name = 'Feasibility button';
    this.mesh.renderOrder = 10000;
    this.hide();
  }

  hide() {
    this.mesh.visible = false;
    this.previousSource = undefined;
    this.pressed = false;
  }

  update(viewer: XRViewerPose, source?: XRInputSource, aim?: XRPose | null) {
    let lowerSlope = Infinity;
    for (const view of viewer.views) {
      const projection = view.projectionMatrix;
      lowerSlope = Math.min(lowerSlope, (1 - projection[9]) / projection[5]);
    }
    const mesh = this.mesh;
    mesh.visible = true;
    mesh.quaternion.copy(viewer.transform.orientation);
    mesh.position.set(0, -.80 * lowerSlope, -1).applyQuaternion(mesh.quaternion).add(viewer.transform.position);
    mesh.updateMatrix();

    let hovered = false;
    if (aim) {
      this.ray.origin.copy(aim.transform.position);
      this.ray.direction.set(0, 0, -1).applyQuaternion(aim.transform.orientation);
      this.ray.applyMatrix4(this.inverse.copy(mesh.matrix).invert());
      const { origin, direction } = this.ray;
      if (direction.z < -.001 && origin.z > 0) {
        const distance = -origin.z / direction.z;
        hovered = Math.abs(origin.x + distance * direction.x) <= width/2
          && Math.abs(origin.y + distance * direction.y) <= height/2;
      }
    }
    const pressed = !!source?.gamepad?.buttons[4]?.pressed;
    if (hovered && source === this.previousSource && pressed && !this.pressed) this.scores.toggle();
    this.previousSource = source;
    this.pressed = pressed;

    const enabled = this.scores.overlay.enabled;
    const state = (enabled ? 'on' : 'off') + (hovered ? '-hover' : '');
    if (state !== this.lastState) {
      this.lastState = state;
      const c = this.canvas.getContext('2d')!;
      c.clearRect(0, 0, 600, 120);
      c.fillStyle = hovered ? '#284657' : '#162329';
      c.strokeStyle = hovered ? '#a4ebff' : '#73868c';
      c.lineWidth = 5;
      c.beginPath(); c.roundRect(4, 4, 592, 112, 28); c.fill(); c.stroke();
      c.fillStyle = '#e6edf1';
      c.beginPath(); c.arc(62, 60, 30, 0, 2*Math.PI); c.fill();
      c.textBaseline = 'middle'; c.textAlign = 'center'; c.font = 'bold 36px system-ui';
      c.fillStyle = '#162329'; c.fillText('X', 62, 61);
      c.fillStyle = '#ffffff'; c.textAlign = 'left'; c.font = '600 46px system-ui';
      c.fillText('Feasibility', 118, 61);
      c.textAlign = 'right'; c.font = 'bold 38px system-ui';
      c.fillStyle = enabled ? '#9ee49d' : '#cad4d8'; c.fillText(enabled ? 'ON' : 'OFF', 556, 61);
      this.texture.needsUpdate = true;
    }
    return hovered;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.texture.dispose();
  }
}
