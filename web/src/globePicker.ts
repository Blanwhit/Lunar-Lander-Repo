import {
  BufferGeometry, CanvasTexture, Group, Line, LineBasicMaterial, MathUtils, Mesh,
  MeshBasicMaterial, PerspectiveCamera, PlaneGeometry, Ray, Scene, Sphere,
  SphereGeometry, SRGBColorSpace, TextureLoader, Vector3, WebGLRenderer,
} from 'three';

import { VrHudButton, VrHudPointers } from './overlay/vrHudButton';
import { VrHeatmap, type VrFeasibility } from './overlay/vrFeasibility';

export interface GlobeHeadset {
  renderer: WebGLRenderer;
  session: XRSession;
  reference: XRReferenceSpaceType;
}

/** Both the controller pose and the globe are in the session's reference space. */
export async function pickLandingInVR(session: XRSession, latitude: number, longitude: number,
  land: (lat: number, lon: number, headset: GlobeHeadset) => Promise<void>, scores?: VrFeasibility) {
  const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.xr.enabled = true;
  let handedOff = false;
  try {
    let reference: XRReferenceSpaceType = 'local-floor';
    try { await session.requestReferenceSpace(reference); } catch { reference = 'local'; }
    renderer.xr.setReferenceSpaceType(reference);
    await renderer.xr.setSession(session);
    handedOff = await showLandingGlobe(renderer, session, latitude, longitude,
      (lat, lon) => land(lat, lon, { renderer, session, reference }), scores);
  } finally {
    if (!handedOff) {
      renderer.setAnimationLoop(null);
      renderer.dispose();
      renderer.forceContextLoss();
    }
  }
}

export async function showLandingGlobe(renderer: WebGLRenderer, session: XRSession,
  latitude: number, longitude: number, land: (lat: number, lon: number) => Promise<boolean | void>, scores?: VrFeasibility) {
  const scene = new Scene(), camera = new PerspectiveCamera(65, 1, .025, 10);
  const scoreButton = scores && VrHudButton.feasibility(scores);
  if (scoreButton) scene.add(scoreButton.mesh);
  const stand = new Group();
  scene.add(stand);
  const map = new TextureLoader().load(import.meta.env.BASE_URL + 'lunar-soil/global-albedo.jpg');
  map.colorSpace = SRGBColorSpace;
  const radius = .40;
  const moon = new Mesh(new SphereGeometry(radius, 96, 64), new MeshBasicMaterial({ map }));
  moon.rotation.set(MathUtils.degToRad(latitude), -Math.PI / 2 - MathUtils.degToRad(longitude), 0);
  stand.add(moon);
  let heatmap: VrHeatmap | undefined;
  const dot = new Mesh(new SphereGeometry(.008, 12, 8), new MeshBasicMaterial({ color: 0x6be8ff }));
  const beam = new Line(new BufferGeometry().setFromPoints([new Vector3(), new Vector3()]),
    new LineBasicMaterial({ color: 0x7ecbda }));
  scene.add(dot, beam);
  dot.visible = beam.visible = false;

  const card = document.createElement('canvas');
  card.width = 1024;
  card.height = 198;
  const ctx = card.getContext('2d')!;
  const text = new CanvasTexture(card);
  text.colorSpace = SRGBColorSpace;
  const label = new Mesh(new PlaneGeometry(1.24, .24), new MeshBasicMaterial({ map: text, transparent: true }));
  label.position.set(0, -.56, 0);
  stand.add(label);
  let lastCaption = '';
  function caption(title: string, detail: string, hint = '') {
    const key = title + detail + hint;
    if (lastCaption === key) return;
    lastCaption = key;
    ctx.clearRect(0, 0, card.width, card.height);
    ctx.textAlign = 'center';
    ctx.fillStyle = 'white';
    ctx.font = '600 50px system-ui';
    ctx.fillText(title, 512, 58);
    ctx.fillStyle = '#c6d4dd';
    ctx.font = '32px system-ui';
    ctx.fillText(detail, 512, 112);
    ctx.fillStyle = '#adbec9';
    ctx.font = '28px system-ui';
    ctx.fillText(hint, 512, 165, 990);
    text.needsUpdate = true;
  }
  const controls = 'Left stick rotates · X lands · Y returns from the surface';
  caption('Point with your left controller', controls);

  let selected = false, landingFailed = false;
  function release() {
    scoreButton?.dispose();
    heatmap?.dispose();
    moon.geometry.dispose(); moon.material.dispose(); map.dispose();
    dot.geometry.dispose(); dot.material.dispose();
    beam.geometry.dispose(); beam.material.dispose();
    label.geometry.dispose(); label.material.dispose(); text.dispose();
  }
  try {
    const bounds = new Sphere(new Vector3(), radius);
    const local = new Vector3();
    const ray = new Ray(), hit = new Vector3(), forward = new Vector3();
    const pointers = new VrHudPointers();
    let anchored = false, lastTime = 0;
    return await new Promise<boolean>((resolve, reject) => {
      let finished = false;
      const ended = () => { finished = true; if (!selected) resolve(false); };
      session.addEventListener('end', ended, { once: true });
      renderer.setAnimationLoop((time, frame) => {
        const space = renderer.xr.getReferenceSpace();
        if (!space || !frame) return;
        const pose = frame.getViewerPose(space);
        if (!pose || session.visibilityState !== 'visible') {
          scoreButton?.hide();
          pointers.reset();
          dot.visible = beam.visible = false;
          return;
        }
        if (!anchored) {
          forward.set(0, 0, -1).applyQuaternion(pose.transform.orientation);
          forward.y = 0;
          if (forward.lengthSq() < .01) forward.set(0, 0, -1);
          forward.normalize();
          stand.position.copy(pose.transform.position).addScaledVector(forward, 1.4);
          stand.position.y -= .08;
          stand.rotation.y = Math.atan2(-forward.x, -forward.z);
          bounds.center.copy(stand.position);
          anchored = true;
        }
        const dt = MathUtils.clamp((time - lastTime) / 1000, 0, .05);
        lastTime = time;
        if (!selected) {
          if (scores?.overlay.enabled && !heatmap) {
            heatmap = new VrHeatmap(scores,radius);
            moon.add(heatmap.group);
          }
          heatmap?.update(time);
          let title = 'Point with your left controller';
          pointers.update(session, frame, space);
          const left = pointers.left;
          const pad = left.source?.gamepad;
          const x = pad?.axes[2] ?? 0, y = pad?.axes[3] ?? 0;
          if (Math.abs(x) > .15) moon.rotation.y += x * dt * 1.6;
          if (Math.abs(y) > .15) moon.rotation.x = MathUtils.clamp(moon.rotation.x + y * dt * 1.6, -Math.PI / 2, Math.PI / 2);
          const aim = left.aim;
          const uiClick = scoreButton?.update(pose, pointers);
          const click = left.faceClick && !uiClick;
          const overButton = left.overButton;
          beam.visible = !!aim && !overButton;
          dot.visible = false;
          if (aim && !overButton) {
            ray.origin.copy(aim.transform.position);
            ray.direction.set(0, 0, -1).applyQuaternion(aim.transform.orientation);
            const onMoon = ray.intersectSphere(bounds, hit);
            if (onMoon) {
              dot.position.copy(hit);
              dot.visible = true;
            } else ray.at(2, hit);
            const line = beam.geometry.getAttribute('position');
            line.setXYZ(0, ray.origin.x, ray.origin.y, ray.origin.z);
            line.setXYZ(1, hit.x, hit.y, hit.z);
            line.needsUpdate = true;
            beam.frustumCulled = false;
            if (onMoon && (click || scores?.overlay.enabled)) {
              moon.worldToLocal(local.copy(hit)).normalize();
              if (scores?.overlay.enabled) title = scores.reading([local.x,-local.z,local.y]);
            }
            if (click && onMoon) {
              selected = true;
              scoreButton?.hide();
              landingFailed = false;
              const lat = MathUtils.radToDeg(Math.asin(MathUtils.clamp(local.y, -1, 1)));
              const lon = MathUtils.radToDeg(Math.atan2(-local.z, local.x));
              caption('Preparing landing', Math.abs(lat).toFixed(3) + '° ' + (lat < 0 ? 'S' : 'N')
                + '    ' + Math.abs(lon).toFixed(3) + '° ' + (lon < 0 ? 'W' : 'E'));
              beam.visible = false;
              void land(lat, lon).then(result => {
                if (result === false && !finished) {
                  landingFailed = true;
                  selected = false;
                } else {
                  session.removeEventListener('end', ended);
                  resolve(result !== false);
                }
              }, error => {
                session.removeEventListener('end', ended);
                reject(error);
              });
            }
          }
          if (!selected) caption(title, landingFailed ? 'Terrain could not load · Press X to try again' : controls, scores?.overlay.enabled
            ? 'Red 0% · Yellow 50% · Green 100%' : '');
        }
        renderer.render(scene, camera);
      });
    });
  } finally {
    release();
  }
}
