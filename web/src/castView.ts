import {castExpanded} from './castPresentation';
import {CastPlayback,CastResolution} from './castPlayback';
import { DirectionalLight, HemisphereLight, Matrix3, Matrix4, Mesh, PerspectiveCamera, Quaternion,
  Scene, Vector3, WebGLRenderer, SphereGeometry, MeshBasicMaterial } from 'three';
import type { SceneFrame } from './castLink';
import type { BrowserGlobe } from './globePicker';
import type { VrFeasibility } from './overlay/vrFeasibility';
import { createSky,createWalkGround,type WalkSite } from './walk';
import { WalkSuit } from './walkSuit';
import { LandingMission,preloadMission } from './landingMission';
import { loadRockSamples } from './lunarRocks';
import { WALK_FAR } from './walkGround';
import { THIRD_PERSON_LAYER } from './suitGear';

type SiteAt=(lat:number,lon:number)=>Promise<WalkSite>;
export type CastWorld={globe:BrowserGlobe;siteAt:SiteAt;scores?:VrFeasibility};
const keyOf=(f:SceneFrame)=>f.mode==='globe'?'globe':f.site!.join(',');
async function surface(world:CastWorld,frame:SceneFrame) {
  const [lat,lon]=frame.site!;
  const site=await world.siteAt(lat,lon);
  const results=await Promise.allSettled([createWalkGround(site,frame.head[0],frame.head[2],world.scores,true),
    WalkSuit.load(),preloadMission(),loadRockSamples()] as const);
  const [g,s,m,r]=results;
  if(g.status!=='fulfilled'||s.status!=='fulfilled'||m.status!=='fulfilled'||r.status!=='fulfilled'){
    if(g.status==='fulfilled')g.value.dispose();
    if(s.status==='fulfilled')s.value.dispose();
    throw new Error('Could not load the landing site');
  }
  const ground=g.value,suit=s.value, rocks=r.value;
  const scene=new Scene(), sun=new Vector3().fromArray(frame.sun!).normalize();
  const sky=createSky(site,sun),fill=new HemisphereLight(0xc7cddc,0x878991,.28);
  sky.renderOrder=2e6;sky.material.depthTest=true;
  const light=new DirectionalLight(0xfff5e6,2.5);
  light.castShadow=sun.y>-.005;
  light.shadow.autoUpdate=false;
  let lastShadow=-Infinity,shadowX=Infinity,shadowZ=Infinity;
  let shadowBody:number[]|undefined,shadowShip:number[]|undefined,shadowRocks=false;
  function poseChanged(current:number[]|undefined,previous:number[]|undefined,lander=false){
    if(!current||!previous)return current!==previous;
    // The lander includes height, throttle and a continuously advancing animation clock.
    return current.length!==previous.length||current.some((v,i)=>
      (!lander||i<7||i>=10)&&Math.abs(v-previous[i])>.004);
  }
  Object.assign(light.shadow.camera,{left:-22,right:22,top:22,bottom:-22,near:.1,far:400});
  light.shadow.camera.updateProjectionMatrix();light.shadow.camera.layers.enable(THIRD_PERSON_LAYER);
  light.shadow.mapSize.set(512,512);light.shadow.normalBias=.003;light.shadow.bias=-.0015/400;
  const mission=new LandingMission(m.value,sun,(x,z)=>ground.floorAt(x,z),(x,z)=>ground.surfaceAt(x,z));
  const dot=new Mesh(new SphereGeometry(.04,10,6),new MeshBasicMaterial({color:0xcae8a8}));
  scene.add(sky,fill,light,light.target,ground.group,suit.group,mission.group,dot);
  const loose:Mesh[]=[];
  let anchorX=frame.head[0],anchorZ=frame.head[2],preparing=false,closed=false;
  return {
    draw(f:SceneFrame, camera:PerspectiveCamera,renderer:WebGLRenderer,dt:number) {
      const {x,z}=camera.position;
      if(!preparing && Math.hypot(x-anchorX,z-anchorZ)>160){
        preparing=true;
        void ground.prepareLanding(x,z).then(()=>{anchorX=x;anchorZ=z;shadowX=Infinity;}).catch(()=>{}).finally(()=>{preparing=false;});
      }
      ground.update(x,z);
      light.intensity=f.light??0;fill.intensity=.55-.27*light.intensity/2.5;

      suit.group.visible=!!f.body;
      if(f.body)suit.applyCastPose(f.body);
      mission.group.visible=!!f.ship;
      if(f.ship)mission.applyCastState(f.ship,dt);
      for(const mesh of loose)mesh.visible=false;
      for(const [i,stone] of (f.samples??[]).entries()){
        const rock=rocks.find(sample=>sample.key===stone.key);
        if(!rock)continue;
        const mesh=loose[i]??=new Mesh(rock.near.geometry,rock.near.material);
        if(!mesh.parent){scene.add(mesh);mesh.matrixAutoUpdate=false;mesh.castShadow=mesh.receiveShadow=true;}
        mesh.geometry=rock.near.geometry;mesh.material=rock.near.material;
        mesh.matrix.fromArray(stone.matrix);mesh.matrixWorldNeedsUpdate=true;mesh.visible=true;
      }
      dot.visible=!!f.pointer;if(f.pointer)dot.position.fromArray(f.pointer);
      const hasRocks=!!f.samples?.length;
      const shadowMoved=Math.hypot(x-shadowX,z-shadowZ)>.15 || poseChanged(f.body,shadowBody)
        || poseChanged(f.ship,shadowShip,true) || hasRocks || shadowRocks;
      if((shadowMoved && f.time-lastShadow>=65) || f.time<lastShadow){
        light.target.position.set(x,ground.floorAt(x,z),z);
        light.position.copy(light.target.position).addScaledVector(sun,80);
        shadowX=x;shadowZ=z;shadowBody=f.body;shadowShip=f.ship;shadowRocks=hasRocks;
        light.shadow.needsUpdate=true;lastShadow=f.time;
      }
      if(!closed)renderer.render(scene,camera);
    },
    dispose(){
      closed=true;ground.dispose();suit.dispose();mission.dispose();light.dispose();
      sky.geometry.dispose();sky.material.dispose();dot.geometry.dispose();dot.material.dispose();scene.clear();
    },
  };
}

const qa=new Quaternion(),qb=new Quaternion();
function blendPose(a:number[],b:number[],t:number,bones=false){
  if(a.length!==b.length)return b;
  const v=b.map((x,i)=>a[i]+(x-a[i])*t);
  const count=bones?Math.floor(b.length/7):1;
  for(let i=0;i<count;i++){
    const j=i*7+3;qa.fromArray(a,j).slerp(qb.fromArray(b,j),t).toArray(v,j);
  }
  return v;
}

// A short interpolation buffer decouples browser drawing from wireless packet arrival.
export function openCastView(canvas:HTMLCanvasElement,world:CastWorld,caption:(t:string)=>void) {
  const renderer=new WebGLRenderer({canvas,antialias:false,powerPreference:'high-performance'});
  renderer.shadowMap.enabled=true;
  const camera=new PerspectiveCamera(75,1,.1,WALK_FAR);
  type Timed={frame:SceneFrame; arrived:number};
  let queue:Timed[]=[],key='',generation=0,closed=false,loading=false;
  let surfaceView:Awaited<ReturnType<typeof surface>>|undefined;
  let last=0,retryAt=0,mirrored=false;
  let relayed=false;
  const clock=new CastPlayback(),resolution=new CastResolution();
  let cssWidth=2,cssHeight=2;
  function measure(){cssWidth=Math.max(2,canvas.clientWidth);cssHeight=Math.max(2,canvas.clientHeight);

  }
  measure();
  const observer=new ResizeObserver(measure);observer.observe(canvas);
  function resetClock(){
    queue.length=0;clock.reset();last=0;
  }
  const viewRot=new Matrix3(),rot=new Matrix4();
  const orbitalDot=new Mesh(new SphereGeometry(.005,10,6),new MeshBasicMaterial({color:0x9beaff,depthTest:false}));
  const dotScene=new Scene();dotScene.add(orbitalDot);
  async function load(f:SceneFrame) {
    const id=++generation;loading=true;
    try{
      const next=await surface(world,f);
      if(closed||id!==generation){next.dispose();return;}
      surfaceView=next;resolution.reset();last=0;
    }catch{if(id===generation){retryAt=performance.now()+5000;caption('Retrying lunar terrain…');}}
    finally{if(id===generation)loading=false;}
  }
  renderer.setAnimationLoop(now=>{
    if(mirrored)return;
    const latest=queue.at(-1);
    if(!latest)return;
    if(latest.frame.mode==='surface'&&!surfaceView){
      if(!loading&&now>retryAt)void load(latest.frame);
      return;
    }
    if(now-latest.arrived>2400){caption('Waiting for Quest tracking…');return;}
    const elapsed=last?Math.max(0,now-last):16.7,dt=Math.min(.12,elapsed/1000);last=now;
    const expanded=castExpanded();
    const dpr=expanded?Math.min(2,window.devicePixelRatio||1):1;
    resolution.layout(cssWidth*cssHeight*dpr*dpr,expanded);
    const density=resolution.scale(now,elapsed)*dpr;
    const w=Math.max(2,Math.round(cssWidth*density)),h=Math.max(2,Math.round(cssHeight*density));
    if(canvas.width!==w||canvas.height!==h)renderer.setSize(w,h,false);

    const playTime=clock.sample(now,elapsed,latest.frame.time,relayed,expanded);
    while(queue.length>2 && queue[1].frame.time<=playTime)queue.shift();
    const a=queue[0].frame,b=(queue[1]??queue[0]).frame;
    const span=Math.max(1,b.time-a.time);
    const t=Math.max(0,Math.min(1,(playTime-a.time)/span));
    const f={...b,time:a.time+(b.time-a.time)*t,head:blendPose(a.head,b.head,t)};
    if(a.body&&b.body)f.body=blendPose(a.body,b.body,t,true);
    if(a.ship&&b.ship)f.ship=blendPose(a.ship,b.ship,t);
    if(a.pointer&&b.pointer)f.pointer=b.pointer.map((n,i)=>a.pointer![i]+(n-a.pointer![i])*t);
    camera.position.fromArray(f.head);camera.quaternion.fromArray(f.head,3).normalize();
    if(camera.aspect!==w/h || camera.fov!==f.fov){
      camera.aspect=w/h;camera.fov=f.fov;camera.updateProjectionMatrix();
    }
    if(f.mode==='surface'){
      if(!surfaceView)return;
      world.scores?.update(now,true);
      surfaceView.draw(f,camera,renderer,dt);caption(f.heat?(f.score??''):'');
    }else{
      viewRot.setFromMatrix4(rot.makeRotationFromQuaternion(camera.quaternion)).transpose();
      world.globe.draw({renderer,camPos:camera.position.toArray(),pivot:f.pivot as [number,number,number],viewRot,
        projection:new Float32Array(camera.projectionMatrix.elements),width:w,height:h,firstEye:true,expandedCast:expanded},dt);
      if(f.pointer){
        orbitalDot.position.fromArray(f.pointer);renderer.autoClear=false;
        renderer.render(dotScene,camera);renderer.autoClear=true;
      }
      caption('');
    }
  });
  return {
    mirroring(on:boolean){
      if(mirrored===on)return;
      mirrored=on;last=0;
      if(!on){clock.reset();for(const entry of queue)clock.receive(entry.frame.time,entry.arrived);}
    },
    reset:resetClock,
    frame(f:SceneFrame,viaRelay=false) {
      if(relayed!==viaRelay){resetClock();relayed=viaRelay;}
      const last=queue.at(-1);
      if(last && f.time<=last.frame.time){
        if(performance.now()-last.arrived<3000 || last.frame.time-f.time<1000)return;
        resetClock();
      }
      const nextKey=keyOf(f);
      if(nextKey!==key){
        key=nextKey;resolution.reset();generation++;surfaceView?.dispose();surfaceView=undefined;resetClock();loading=false;retryAt=0;
        caption(f.mode==='surface'?'Loading lunar terrain…':'');
      }
      const now=performance.now();
      queue.push({frame:f,arrived:now});
      clock.receive(f.time,now);
      if(queue.length>192)queue.shift();
    },
    close(){closed=true;observer.disconnect();generation++;renderer.setAnimationLoop(null);surfaceView?.dispose();orbitalDot.geometry.dispose();
      orbitalDot.material.dispose();renderer.dispose();renderer.forceContextLoss();},
  };
}
