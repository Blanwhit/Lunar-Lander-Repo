import {nativeChannelPrefix,createEyeWriter} from './bufferedEye';
import type {WebGLRenderer} from 'three';
import {createEyeCapture} from './castEye';
// The paired peer connection carries live poses and optional astronaut-eye video.
export type CastPose = number[]; // position (3), quaternion (4)
export type SceneFrame = {
  mode:'surface'|'globe'; time:number; head:CastPose; fov:number;
  site?:number[]; sun?:number[]; light?:number; score?:string; heat?:boolean;
  body?:number[]; ship?:number[]; pivot?:number[]; pointer?:number[];
  samples?:{key:string; matrix:number[]}[];
};
type Signal = {id:string; offer:string; answer?:string; online?:boolean; watch?:boolean; frame?:SceneFrame; history?:SceneFrame[]};
export async function castSignal(action:string,key:string,body:object={},signal?:AbortSignal):Promise<Signal|null> {
  const r=await fetch('/api/quest/cast-'+action,{method:'POST',cache:'no-store',signal,
    headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify(body)});
  if(r.status===404 || r.status===409)return null;
  if(!r.ok)throw new Error('Could not reach the Quest connection');
  return r.json();
}
export function castPeer() {
  return new RTCPeerConnection({iceServers:[{urls:'stun:stun.cloudflare.com:3478'}]});
}
export async function localSDP(pc:RTCPeerConnection, type:'offer'|'answer') {
  await pc.setLocalDescription(type==='offer'?await pc.createOffer():await pc.createAnswer());
  if(pc.iceGatheringState!=='complete') await new Promise<void>(resolve=>{
    const finish=()=>{clearTimeout(timer);pc.removeEventListener('icegatheringstatechange',check);resolve();};
    const check=()=>{if(pc.iceGatheringState==='complete'||pc.signalingState==='closed')finish();};
    const timer=setTimeout(finish,3000);
    pc.addEventListener('icegatheringstatechange',check);check();
  });
  if(!pc.localDescription)throw new Error('Cast connection closed');
  return pc.localDescription.sdp;
}
// Keep world-space camera coordinates as doubles. The animated rig only needs float precision.
const encoder=new TextEncoder(),decoder=new TextDecoder();
function pack(frame:SceneFrame) {
  const {body,...scene}=frame;
  if(!body)return JSON.stringify(scene);
  const meta=encoder.encode(JSON.stringify(scene));
  const offset=4+Math.ceil(meta.length/4)*4;
  const data=new ArrayBuffer(offset+body.length*4);
  new DataView(data).setUint32(0,meta.length,true);
  new Uint8Array(data,4,meta.length).set(meta);
  new Float32Array(data,offset).set(body);
  return data;
}
export function unpack(data:ArrayBuffer):SceneFrame {
  const length=new DataView(data).getUint32(0,true);
  const scene=JSON.parse(decoder.decode(new Uint8Array(data,4,length)));
  scene.body=Array.from(new Float32Array(data,4+Math.ceil(length/4)*4));
  return scene;
}

let outgoing:RTCDataChannel|undefined, watching=false, packed=false;
let eyeSender:RTCRtpSender|undefined, eyeRequested=false, eyeFailed=false, nextEye=0;
let capture:ReturnType<typeof createEyeCapture>|undefined;

let native:{token:string;channel:RTCDataChannel;writer:ReturnType<typeof createEyeWriter>}|undefined;
function closeNative(){
  const old=native;native=undefined;old?.writer.close();
}
function stopEye(){
  if(capture){native?.writer.idle();void eyeSender?.replaceTrack(null).catch(()=>{});capture.close();capture=undefined;}
  nextEye=0;
}

export function releaseEyeFrame(renderer:WebGLRenderer){
  if(capture?.renderer===renderer)stopEye();
}

export function shareEyeFrame(time:number,renderer:WebGLRenderer,view:XRView|undefined){
  if(!view||!eyeRequested||eyeFailed||!eyeSender||time+1<nextEye)return;
  // Capture on a whole number of headset refreshes so pans keep an even cadence.
  if(native && !native.writer.canCapture())return;
  if(native && native.channel.readyState!=='open')return;
  const hz=renderer.xr.getSession()?.frameRate||72;
  const period=1000*Math.max(1,Math.ceil(hz/(native?.writer.frameLimit??60)))/hz;
  nextEye=time-nextEye>period?time+period:nextEye+period;
  const rect=renderer.xr.getCamera().cameras[0]?.viewport;
  if(!rect || rect.z<2 || rect.w<2)return;
  try{
    if(!capture || capture.renderer!==renderer || capture.width!==rect.z || capture.height!==rect.w){
      stopEye();nextEye=time+period;
      const sender=eyeSender,source=capture=createEyeCapture(renderer,rect.z,rect.w,!native);
      if(source.track)void sender.replaceTrack(source.track).then(async()=>{
        if(capture!==source)return;
        const params=sender.getParameters();
        if(!params.encodings.length)return;
        params.encodings[0].maxBitrate=28000000;
        params.encodings[0].scaleResolutionDownBy=1;
        params.encodings[0].maxFramerate=60;
        params.degradationPreference='maintain-resolution';
        await sender.setParameters(params).catch(()=>{});
      }).catch(()=>{if(capture===source){eyeFailed=true;stopEye();}});
    }
    capture?.draw(view);
    if(capture && native)native.writer.draw(capture.canvas,time,1000/period);
  }catch{eyeFailed=true;stopEye();}
}
let relay:((time:number,sample:()=>SceneFrame)=>void)|undefined;
export function sendCastFrame(time:number, sample:()=>SceneFrame) {
  if(watching && outgoing?.readyState==='open'){
    // Unordered poses expire on the next XR tick. Never queue a stale pose behind a slow link.
    if(outgoing.bufferedAmount>8192)return;
    const f=sample();
    if(f.mode==='globe' && capture)stopEye();
    const data=packed?pack(f):JSON.stringify(f);
    if(typeof data==='string')outgoing.send(data);else outgoing.send(data);
  }else relay?.(time,sample);
}
export function shareQuest(room:string,signal:AbortSignal) {
  let relayReady=false,busy=false,lastSample=-Infinity,lastUpload=-Infinity;
  const history:SceneFrame[]=[];
  const upload=(time:number,sample:()=>SceneFrame)=>{
    if(!relayReady){history.length=0;return;}
    if(time-lastSample<1000/36-1)return;
    lastSample=time;
    const frame=sample();
    if(frame.body)frame.body=frame.body.map(n=>Math.round(n*100000)/100000);
    history.push(frame);
    while(history.length>12 || time-history[0].time>420)history.shift();
    if(busy || time-lastUpload<65)return;
    busy=true;lastUpload=time;
    void castSignal('frame',room,{history},signal).then(r=>{if(r?.watch===false)relayReady=false;})
      .catch(()=>{}).finally(()=>{busy=false;});
  };
  relay=upload;
  let presenceTimer=0;
  async function presence(){
    try{const r=await castSignal('presence',room,{},signal);if(!signal.aborted)relayReady=!!r?.watch;}catch{}
    if(!signal.aborted)presenceTimer=window.setTimeout(presence,2500);
  }
  void presence();
  signal.addEventListener('abort',()=>{clearTimeout(presenceTimer);if(relay===upload){relay=undefined;relayReady=false;}},{once:true});
  if(typeof RTCPeerConnection==='undefined')return;
  let pc:RTCPeerConnection|undefined, offer='', timer=0;
  function close() {
    if(outgoing){outgoing.onclose=null;outgoing.onmessage=null;outgoing.close();outgoing=undefined;}
    closeNative();stopEye();eyeRequested=false;eyeFailed=false;eyeSender=undefined;
    watching=false;packed=false;pc?.close();pc=undefined;offer='';
  }
  signal.addEventListener('abort',()=>{clearTimeout(timer);close();},{once:true});
  async function poll() {
    try {
      const next=await castSignal('status',room,{},signal);
      if(signal.aborted)return;
      if(next && next.id!==offer){
        close();offer=next.id;
        const peer=pc=castPeer();
        peer.ondatachannel=e=>{
          if(signal.aborted || peer!==pc){e.channel.close();return;}
          const ch=outgoing=e.channel;
          const capabilities=()=>{
            if(!eyeSender)return;
            ch.send('supports-eye');
            if(typeof VideoEncoder!=='undefined')ch.send('supports-buffered');
          };
          const announce=()=>{ch.send('supports-packed');capabilities();};
          if(ch.readyState==='open')announce();else ch.onopen=announce;
          ch.onmessage=msg=>{
            if(msg.data==='ping'){ch.send('alive');if(!native)capabilities();return;}
            if(typeof msg.data==='string' && msg.data.startsWith('watch-buffered:')){
              const [,token,list]=msg.data.split(':');
              if(native?.token===token)return;
              if(!/^[a-f0-9-]{36}$/.test(token)||!list||!eyeSender)return;
              if(typeof VideoEncoder==='undefined'){ch.send('buffer-failed:'+token);return;}
              closeNative();stopEye();
              const channel=peer.createDataChannel(nativeChannelPrefix+token,{ordered:true});
              const fail=()=>{if(native?.channel===channel){if(ch.readyState==='open')ch.send('buffer-failed:'+token);closeNative();stopEye();}};
              native={token,channel,writer:createEyeWriter(channel,list.split(','),fail)};
              channel.onclose=channel.onerror=fail;
              eyeRequested=packed=watching=true;eyeFailed=false;return;
            }
            if(native){closeNative();stopEye();}
            const eye=msg.data==='watch-eye';
            if(!eye){stopEye();eyeFailed=false;}
            eyeRequested=eye;packed=eye||msg.data==='watch-packed';watching=packed||msg.data==='watch';
          };
          ch.onclose=()=>{if(outgoing===ch){closeNative();stopEye();eyeRequested=false;outgoing=undefined;watching=false;}};
        };
        await peer.setRemoteDescription({type:'offer',sdp:next.offer});
        if(typeof HTMLCanvasElement.prototype.captureStream==='function'){
          const video=peer.getTransceivers().find(t=>t.receiver.track.kind==='video');
          if(video){video.direction='sendonly';eyeSender=video.sender;}
        }
        const answer=await localSDP(peer,'answer');
        if(!signal.aborted)await castSignal('answer',room,{id:offer,sdp:answer},signal);
      }
    } catch {if(!signal.aborted && pc?.connectionState!=='connected')close();}
    if(!signal.aborted)timer=window.setTimeout(poll,pc?.connectionState==='connected'?4000:1200);
  }
  void poll();
}
