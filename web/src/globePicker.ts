import { sendCastFrame } from './castLink';
import {
  CanvasTexture, PlaneGeometry, Matrix3, Matrix4, Mesh, MeshBasicMaterial, PerspectiveCamera, Quaternion, Scene,
  SphereGeometry, Vector3, Vector4, WebGLRenderer,
} from 'three';
import type { ControlsState } from './controls';
import { VrPointers } from './vrPointers';
import type { Listen, SurfacePoint, Visit } from './questHandoff';
import type { VrFeasibility } from './overlay/vrFeasibility';

export interface GlobeHeadset {
  renderer: WebGLRenderer;
  session: XRSession;
  reference: XRReferenceSpaceType;
  listen?: Listen;
}

export interface GlobeEye extends ControlsState {
  projection: Float32Array;
  width: number;
  height: number;
  renderer: WebGLRenderer;
  firstEye: boolean;
  expandedCast?: boolean;
}

export interface BrowserGlobe {
  active(renderer: WebGLRenderer | null): void;
  navigate(dt: number, horizontal: number, vertical: number, zoom: number): ControlsState;
  pick(origin: Vector3, direction: Vector3): Vector3 | null;
  draw(eye: GlobeEye, dt: number): void;
}

/** The session is requested from the headset button's click, before pairing or loading terrain. */
export async function openSurfaceVR(session: XRSession, start:(headset:GlobeHeadset)=>Promise<void>) {
  const renderer = new WebGLRenderer({ antialias:true, powerPreference:'high-performance' });
  renderer.xr.enabled=true;
  const scene=new Scene(), camera=new PerspectiveCamera(60,1,.02,10);
  const card=document.createElement('canvas');card.width=512;card.height=64;
  const ctx=card.getContext('2d')!;ctx.fillStyle='white';ctx.font='27px system-ui';
  ctx.textAlign='center';ctx.fillText('Loading lunar surface…',256,43);
  const texture=new CanvasTexture(card);
  const label=new Mesh(new PlaneGeometry(.72,.09),new MeshBasicMaterial({map:texture,transparent:true}));
  scene.add(label);
  let transferred=false;
  try {
    let reference: XRReferenceSpaceType='local-floor';
    try{await session.requestReferenceSpace(reference);}catch{reference='local';}
    renderer.xr.setReferenceSpaceType(reference);
    await renderer.xr.setSession(session);
    renderer.setAnimationLoop((_time,frame)=>{
      const space=renderer.xr.getReferenceSpace();
      const pose=space && frame?.getViewerPose(space);
      if(!pose)return;
      label.quaternion.copy(pose.transform.orientation);
      label.position.set(0,0,-1.6).applyQuaternion(label.quaternion).add(pose.transform.position);
      renderer.render(scene,camera);
    });
    await start({renderer,session,reference});
    transferred=true;
  } finally {
    if(!transferred){renderer.setAnimationLoop(null);await session.end().catch(()=>{});renderer.dispose();renderer.forceContextLoss();}
    label.geometry.dispose();label.material.dispose();texture.dispose();
  }
}

export async function showLandingGlobe(renderer: WebGLRenderer, session: XRSession, globe: BrowserGlobe,
  land: (lat: number, lon: number) => Promise<boolean | void>, scores?: VrFeasibility, listen?: Listen) {
  const hud = new Scene(), camera = new PerspectiveCamera(65, 1, .025, 10);
  const pointers = new VrPointers();
  let preparing=false;
  const visit: Visit = async ({lat,lon}:SurfacePoint) => {
    if(preparing)return false;
    preparing=true;
    try{
      const ok = (await land(lat,lon)) !== false;
      if(ok)finish(true);
      return ok;
    } finally {preparing=false;}
  };
  const dot = new Mesh(new SphereGeometry(.005, 8, 6), new MeshBasicMaterial({color:0x9beaff,depthTest:false}));
  hud.add(dot);
  const anchor = new Vector3(), initialHead = new Quaternion(), orientation = new Quaternion();
  const trackingToBody = new Matrix3(), rotation = new Matrix4();
  const origin = new Vector3(), direction = new Vector3();
  const viewport = new Vector4(), scissor = new Vector4();
  let anchored = false, lastTime = 0, finish!: (ok: boolean) => void;
  const ended = () => finish(false);
  const result = new Promise<boolean>(resolve => { finish = resolve; });
  session.addEventListener('end', ended, {once:true});
  globe.active(renderer);
  listen?.(visit);
  try {
    renderer.setAnimationLoop((time, frame) => {
      const space = renderer.xr.getReferenceSpace();
      if (!frame || !space) return;
      const pose = frame.getViewerPose(space);
      if (!pose || session.visibilityState !== 'visible') { pointers.reset(); return; }
      const dt = lastTime ? Math.min(.1, (time-lastTime)/1000) : 0;
      lastTime = time;
      if (!anchored) {
        anchor.copy(pose.transform.position);
        initialHead.copy(pose.transform.orientation).invert();
        anchored = true;
      }
      pointers.update(session,frame,space);
      const left = pointers.left.source?.gamepad, right = pointers.right.source?.gamepad;
      const axis = (n = 0) => Math.abs(n) > .15 && !preparing ? n : 0;
      const state = globe.navigate(dt,axis(left?.axes[2]),axis(left?.axes[3]),axis(right?.axes[3]));
      // The first headset pose looks along the desktop camera. Later poses are relative to it.
      trackingToBody.copy(state.viewRot).transpose().multiply(
        new Matrix3().setFromMatrix4(rotation.makeRotationFromQuaternion(initialHead)));
      const positionInBody = (p: DOMPointReadOnly) =>
        origin.copy(p).sub(anchor).applyMatrix3(trackingToBody).add(new Vector3(...state.camPos));

      dot.visible = false;
      for (const hand of pointers.hands) {
        const aim = hand.aim;
        if (!aim) continue;
        direction.set(0,0,-1).applyQuaternion(aim.transform.orientation);
        const hit = globe.pick(positionInBody(aim.transform.position), direction.applyMatrix3(trackingToBody));
        if (!hit) continue;
        dot.position.set(0,0,-.85).applyQuaternion(aim.transform.orientation).add(aim.transform.position);
        dot.visible = true;
        hit.normalize();
        if (hand.faceClick && !preparing) {
          void visit({lat:Math.asin(hit.z)*180/Math.PI,lon:Math.atan2(hit.y,hit.x)*180/Math.PI})
            .catch(error=>console.warn('Surface travel failed',error));
        }
        if (hand.faceClick || !pointers.right.faceClick) break;
      }
      scores?.update(time,true);

      // Orbital terrain uses camera-relative doubles and its own projection uniforms. Draw
      // that same renderer into each XR viewport, then composite the controller HUD in metres.
      const eyes = renderer.xr.getCamera().cameras;
      renderer.getViewport(viewport);
      renderer.getScissor(scissor);
      const wasScissored = renderer.getScissorTest(), autoClear = renderer.autoClear;
      renderer.xr.enabled = false;
      try {
        renderer.setScissorTest(true);
        renderer.autoClear = true;
        for (const [i,view] of pose.views.entries()) {
          const rect = eyes[i]?.viewport;
          if (!rect) continue;
          renderer.setViewport(rect); renderer.setScissor(rect);
          const p = positionInBody(view.transform.position);
          const bodyToEye = new Matrix3().setFromMatrix4(rotation.makeRotationFromQuaternion(
            orientation.copy(view.transform.orientation))).premultiply(trackingToBody).transpose();
          if(i===0)sendCastFrame(time,()=>({
            mode:'globe',time,heat:!!scores?.overlay.enabled,pivot:[...state.pivot],
            head:[...p.toArray(),...new Quaternion().setFromRotationMatrix(new Matrix4().setFromMatrix3(bodyToEye).transpose()).toArray()],
            fov:2*Math.atan(1/view.projectionMatrix[5])*180/Math.PI,
            pointer:dot.visible?dot.position.clone().sub(anchor).applyMatrix3(trackingToBody).add(new Vector3(...state.camPos)).toArray():undefined,
          }));
          globe.draw({renderer,camPos:[p.x,p.y,p.z],pivot:state.pivot,viewRot:bodyToEye,
            projection:view.projectionMatrix,width:rect.z,height:rect.w,firstEye:i===0}, dt/pose.views.length);
        }
      } finally {
        renderer.xr.enabled = true;
        renderer.setScissor(scissor); renderer.setScissorTest(wasScissored);
        renderer.setViewport(viewport);
        renderer.autoClear = false;
        try { renderer.render(hud,camera); } finally {renderer.autoClear = autoClear;}
      }
    });
    return await result;
  } finally {
    globe.active(null);
    session.removeEventListener('end',ended);
    dot.geometry.dispose();dot.material.dispose();
  }
}
