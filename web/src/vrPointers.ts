/** Sample each hand once per XR frame, for pointing and controller actions. */
class HudPointer {
  source?: XRInputSource;
  aim: XRPose | null = null;
  faceClick = false;
  triggerPressure = 0;
  private faceDown = false;

  sample(source?: XRInputSource, aim: XRPose | null = null) {
    const same = !!source && this.source === source;
    const face = !!source?.gamepad?.buttons[4]?.pressed;
    const trigger = source?.gamepad?.buttons[0];
    const down = !!trigger?.pressed;
    this.faceClick = same && face && !this.faceDown;
    this.triggerPressure = trigger?.value ?? (down ? 1 : 0);
    this.faceDown = face;
    this.source = source;
    this.aim = aim;
  }
}

export class VrPointers {
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
