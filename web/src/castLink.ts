import type {CastSoilTile} from './castSoil';
export type CastPose = number[]; // position (3), quaternion (4)
export type SceneFrame = {
  mode:'surface'|'globe'; time:number; head:CastPose; fov:number;
  site?:number[]; sun?:number[]; light?:number; score?:string; heat?:boolean;
  body?:number[]; ship?:number[]; pivot?:number[]; pointer?:number[];
  trail?:string; soil?:CastSoilTile;
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
let relay:((time:number,sample:()=>SceneFrame)=>void)|undefined;
export function sendCastFrame(time:number, sample:()=>SceneFrame) {
  if(watching && outgoing?.readyState==='open'){
    // Unordered poses expire on the next XR tick. Never queue a stale pose behind a slow link.
    if(outgoing.bufferedAmount>8192)return;
    const f=sample();
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
          const announce=()=>ch.send('supports-packed');
          if(ch.readyState==='open')announce();else ch.onopen=announce;
          ch.onmessage=msg=>{
            if(msg.data==='ping'){ch.send('alive');return;}
            // Older desktop clients may still request eye video. Send only pose data.
            packed=msg.data==='watch-packed'||msg.data==='watch-eye'||
              (typeof msg.data==='string'&&msg.data.startsWith('watch-buffered:'));
            watching=packed||msg.data==='watch';
          };
          ch.onclose=()=>{if(outgoing===ch){outgoing=undefined;watching=false;}};
        };
        await peer.setRemoteDescription({type:'offer',sdp:next.offer});
        const answer=await localSDP(peer,'answer');
        if(!signal.aborted)await castSignal('answer',room,{id:offer,sdp:answer},signal);
      }
    } catch {if(!signal.aborted && pc?.connectionState!=='connected')close();}
    if(!signal.aborted)timer=window.setTimeout(poll,pc?.connectionState==='connected'?4000:1200);
  }
  void poll();
}
