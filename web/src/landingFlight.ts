import { MathUtils, Matrix4, Quaternion, Vector3 } from 'three';
import type { GlobeControls } from './controls';
import { R_MOON } from './geom';

const eyeHeight = 1.65;

export interface LandingFrame {
  arrived: boolean;
  distance: number;
  tilt: number;
  opacity: number;
  fov: number;
  approach: number;
}

/** One distance curve drives both renderers; their matching cameras overlap at low altitude. */
export function landingFlight(orbit: GlobeControls, destinationFrame: Matrix4) {
  const startRotation = orbit.orientation();
  const endRotation = new Quaternion().setFromRotationMatrix(destinationFrame);
  const up = new Vector3().setFromMatrixColumn(destinationFrame, 1);
  const separation = orbit.tgt.angleTo(up);
  const startLog = Math.log(orbit.dist);
  const endLog = Math.log(eyeHeight);
  const cruiseLog = Math.log(Math.max(orbit.dist, R_MOON * separation * 0.65));
  const hasClimb = cruiseLog > startLog + 0.08;
  const initialTilt = orbit.tilt();
  const rotation = new Quaternion();
  return {
    duration: 1300 + 170 * (startLog - endLog) + (hasClimb ? 900 : 0),
    sample(t: number): LandingFrame {
      const progress = MathUtils.smootherstep(t, 0, 1);
      const align = MathUtils.smootherstep(t, 0, hasClimb ? 0.6 : 0.48);
      const log = hasClimb
        ? MathUtils.lerp(MathUtils.lerp(startLog, cruiseLog, MathUtils.smootherstep(t, 0, 0.3)),
          endLog, MathUtils.smootherstep(t, 0.32, 1))
        : MathUtils.lerp(startLog, endLog, progress);
      const distance = Math.exp(log);
      const surface = MathUtils.smootherstep(Math.log(1500) - log, 0, Math.log(1500/180));
      // A landing triggered at minimum zoom starts at the current orbital lens and pitch.
      const finalApproach = (1 - MathUtils.smootherstep(log, endLog, Math.log(200)))
        * MathUtils.smootherstep(t, 0, 0.5);
      const tilt = MathUtils.lerp(orbit.autoTilt(distance), Math.PI/2 - 0.12, finalApproach)
        + (initialTilt - orbit.autoTilt(Math.exp(startLog))) * (1 - MathUtils.smootherstep(t, 0, 0.5));
      rotation.slerpQuaternions(startRotation, endRotation, align);
      orbit.tgt.set(0,1,0).applyQuaternion(rotation);
      orbit.fwd.set(0,0,-1).applyQuaternion(rotation);
      orbit.dist = distance;
      orbit.logDistGoal = log;
      orbit.tiltGoal = orbit.tiltUser = tilt - orbit.autoTilt(distance);
      orbit.changed = true;
      return { arrived: t >= 1, distance, tilt, opacity: surface * MathUtils.smootherstep(t, hasClimb ? .60 : .48, hasClimb ? .72 : .60), fov: 45 + 25 * finalApproach, approach: finalApproach };
    },
  };
}
