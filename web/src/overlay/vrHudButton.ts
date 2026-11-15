import { CanvasTexture, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry, Ray, SRGBColorSpace } from 'three';
import type { VrFeasibility } from './vrFeasibility';

const width = .44, height = .088;

/** Sample each hand once per XR frame, before dispatching hits to either button. */
class HudPointer {
  source?: XRInputSource;
  aim: XRPose | null = null;
  overButton = false;
  faceClick = false;
  triggerClick = false;
  triggerPressure = 0;
  triggerCaptured = false;
  private faceDown = false;
  private triggerDown = false;

  sample(source?: XRInputSource, aim: XRPose | null = null) {
    const same = !!source && this.source === source;
    const face = !!source?.gamepad?.buttons[4]?.pressed;
    const trigger = source?.gamepad?.buttons[0];
    const down = !!trigger?.pressed;
    this.faceClick = same && face && !this.faceDown;
    this.triggerClick = same && down && !this.triggerDown;
    this.triggerPressure = trigger?.value ?? (down ? 1 : 0);
    // A held UI trigger stays captured until release, including across scene changes.
    this.triggerCaptured = this.triggerPressure > .12 && (!same || this.triggerCaptured);
    this.faceDown = face;
    this.triggerDown = down;
    this.overButton = false;
    this.source = source;
    this.aim = aim;
  }
}

export class VrHudPointers {
  readonly left = new HudPointer();
  readonly right = new HudPointer();
  readonly hands = [this.left, this.right];

  update(session: XRSession, frame: XRFrame, space: XRReferenceSpace) {
    let left: XRInputSource | undefined, right: XRInputSource | undefined;
    for (const source of session.inputSources) {
      if (source.gamepad?.mapping !== 'xr-standard') continue;
      if (source.handedness === 'left') left = source;
      if (source.handedness === 'right') right = source;
    }
    this.left.sample(left, left && frame.getPose(left.targetRaySpace, space));
    this.right.sample(right, right && frame.getPose(right.targetRaySpace, space));
  }

  reset() {
    for (const hand of this.hands) hand.sample();
  }
}

/** A stereo HUD button. The mesh and the controller hit test use the same XR reference space. */
export class VrHudButton {
  readonly mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly canvas = document.createElement('canvas');
  private readonly texture: CanvasTexture;
  private readonly inverse = new Matrix4();
  private readonly ray = new Ray();
  private lastState = '';

  static feasibility(scores: VrFeasibility, offsetX = 0) {
    return new VrHudButton('Feasibility', scores.toggle, offsetX, () => scores.overlay.enabled);
  }

  constructor(private label: string, private activate: () => void,
    private offsetX: number, private getEnabled?: () => boolean) {
    this.canvas.width = 600;
    this.canvas.height = 120;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.mesh = new Mesh(new PlaneGeometry(width, height), new MeshBasicMaterial({
      map: this.texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
    }));
    this.mesh.name = label + ' button';
    this.mesh.renderOrder = 10000;
    this.hide();
  }

  hide() {
    this.mesh.visible = false;
  }

  update(viewer: XRViewerPose, pointers: VrHudPointers) {
    let lowerSlope = Infinity;
    for (const view of viewer.views) {
      const projection = view.projectionMatrix;
      lowerSlope = Math.min(lowerSlope, (1 - projection[9]) / projection[5]);
    }
    const mesh = this.mesh;
    mesh.visible = true;
    mesh.quaternion.copy(viewer.transform.orientation);
    mesh.position.set(this.offsetX, -.80 * lowerSlope, -1).applyQuaternion(mesh.quaternion).add(viewer.transform.position);
    mesh.updateMatrix();

    this.inverse.copy(mesh.matrix).invert();
    let hoverLeft = false, hoverRight = false, clicked = false;
    for (const hand of pointers.hands) {
      if (!hand.aim) continue;
      this.ray.origin.copy(hand.aim.transform.position);
      this.ray.direction.set(0, 0, -1).applyQuaternion(hand.aim.transform.orientation);
      this.ray.applyMatrix4(this.inverse);
      const { origin, direction } = this.ray;
      if (direction.z >= -.001 || origin.z <= 0) continue;
      const distance = -origin.z / direction.z;
      if (Math.abs(origin.x + distance * direction.x) > width/2
          || Math.abs(origin.y + distance * direction.y) > height/2) continue;
      hand.overButton = true;
      if (hand.triggerPressure > .12) hand.triggerCaptured = true;
      if (hand === pointers.left) hoverLeft = true;
      else hoverRight = true;
      if (hand.faceClick || hand.triggerClick) clicked = true;
    }
    const hovered = hoverLeft || hoverRight;
    let badge = 'X/A';
    if (hoverLeft !== hoverRight) badge = hoverLeft ? 'X' : 'A';

    if (clicked) this.activate();
    const enabled = this.getEnabled?.();
    const state = (enabled ? 'on' : 'off') + (hovered ? '-hover' : '') + badge;
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
      c.fillStyle = '#162329'; c.fillText(badge, 62, 61, 50);
      c.fillStyle = '#ffffff'; c.textAlign = 'left'; c.font = '600 46px system-ui';
      c.fillText(this.label, 118, 61, enabled === undefined ? 450 : 330);
      if (enabled !== undefined) {
        c.textAlign = 'right'; c.font = 'bold 38px system-ui';
        c.fillStyle = enabled ? '#9ee49d' : '#cad4d8'; c.fillText(enabled ? 'ON' : 'OFF', 556, 61);
      }
      this.texture.needsUpdate = true;
    }
    return clicked;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.texture.dispose();
  }
}
