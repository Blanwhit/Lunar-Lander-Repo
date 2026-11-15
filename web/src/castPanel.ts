import {nativeChannelPrefix,playableEyes,playBufferedEye} from './bufferedEye';
import {castPeer,castSignal,localSDP,unpack,type SceneFrame} from './castLink';
import {setCastPresentation} from './castPresentation';
import type {CastWorld,openCastView} from './castView';

export function mountCastPanel(world:CastWorld) {
  const host=document.createElement('aside');
  host.className='moon-cast';host.setAttribute('aria-label','Quest casting');
  host.innerHTML='<dialog class="cast-window" aria-label="Live Quest view" hidden><header><span>Quest view</span><button type="button" aria-label="Resize Quest view">Resize</button><button type="button" aria-label="Close Quest view">Close</button></header><div class="cast-picture"><canvas aria-label="Live view from the Quest"></canvas><video autoplay muted playsinline aria-label="Live astronaut eye view"></video><canvas class="buffered-eye" aria-label="Buffered Quest eye view"></canvas><span class="cast-caption" role="status"></span></div></dialog><div class="cast-status"><span role="status">Connecting to Quest…</span><button type="button" disabled>Cast</button></div>';
  const style=document.createElement('style');
  style.textContent=`
.moon-cast{position:fixed;z-index:1200;right:12px;bottom:var(--cast-above-hud,84px);display:grid;justify-items:end;gap:6px;color:#eef2f4;font:500 13px/1.35 system-ui,sans-serif}
.moon-cast[hidden],.moon-cast [hidden]{display:none}
.cast-status,.cast-window{background:#171b1eee;border:1px solid #50565b;border-radius:10px;box-shadow:0 3px 14px #0005}
.cast-status,.cast-window header{display:flex;align-items:center;gap:10px;padding:6px 9px}
.cast-status span::before{content:'';display:inline-block;width:7px;height:7px;margin-right:7px;background:#b0a38b;border-radius:50%}
.moon-cast[data-connected] .cast-status span::before{background:#96c9a6}
.moon-cast button{margin:0;color:inherit;background:#2a3034;border:1px solid #616a70;border-radius:6px;padding:4px 9px;font:inherit;cursor:pointer}
.moon-cast button:disabled{opacity:.5;cursor:default}
.cast-window{position:static;margin:0;padding:0;box-sizing:border-box;color:inherit;font:inherit;width:min(360px,44vw);overflow:hidden}
 .cast-window:modal{position:fixed;inset:0;margin:auto;width:96vw;height:94vh;height:94dvh;max-width:none;max-height:none;display:grid;grid-template-rows:auto minmax(0,1fr)}
.cast-window:modal::backdrop{background:rgba(9,14,20,.48)}
.cast-window:modal .cast-picture{aspect-ratio:auto;min-height:0}
.cast-window header span{margin-right:auto}
.cast-picture{position:relative;background:#090b0e;aspect-ratio:16/10}
.cast-picture canvas{display:block;width:100%;height:100%}
.cast-picture video,.cast-picture .buffered-eye{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#06080a;opacity:0;pointer-events:none}
.cast-picture[data-eye] video:not(.buffered-eye),.cast-picture[data-native] .buffered-eye{opacity:1}
.cast-caption:not(:empty){position:absolute;bottom:6px;left:7px;padding:3px 6px;background:#141a20de;border-radius:4px}
body:has(.walk-scene:not([inert])) .moon-cast{bottom:max(12px,env(safe-area-inset-bottom))}
@media(max-width:860px){body:has(.walk-scene:not([inert])) .moon-cast{bottom:112px}}
@media(max-width:580px){.cast-window{width:min(310px,70vw)}}
  `;
  document.head.append(style);document.body.append(host);
  const hud=document.querySelector<HTMLElement>('.moon-hud');
  const hudSize=new ResizeObserver(()=>{
    if(hud)host.style.setProperty('--cast-above-hud',(hud.offsetHeight+7)+'px');
  });
  if(hud)hudSize.observe(hud);
  const panel=host.querySelector<HTMLDialogElement>('.cast-window')!;
  const status=host.querySelector<HTMLElement>('.cast-status span')!;
  const action=host.querySelector<HTMLButtonElement>('.cast-status button')!;
  let canvas=host.querySelector('canvas')!;
  const video=host.querySelector('video')!;
  const picture=video.parentElement!;
  const subtitle=host.querySelector<HTMLElement>('.cast-caption')!;
  const caption=(s:string)=>{if(subtitle.textContent!==s)subtitle.textContent=s;};
  let view:ReturnType<typeof openCastView>|undefined,viewId=0;
  let pc:RTCPeerConnection|undefined,ch:RTCDataChannel|undefined;
  let remoteEye:MediaStreamTrack|undefined,supportsEye=false,surfaceMode=false,frameCallback=0,stall=0;
  let formats:string[]=[];
  void playableEyes().then(keys=>{formats=keys;if(view&&nativeCapable)watch();});
  const buffered=host.querySelector<HTMLCanvasElement>('.buffered-eye')!;
  let nativeCapable=false,token='',nativeFailed=false,nativeTimer=0;
  let closeReader:(()=>void)|undefined;
  function showNative(on:boolean){
    picture.toggleAttribute('data-native',on);
    view?.mirroring(on||picture.hasAttribute('data-eye'));
    if(on)caption('');
  }
  function stopBuffer(){
    clearTimeout(nativeTimer);token='';
    const close=closeReader;closeReader=undefined;close?.();
  }
  function failBuffer(){
    if(!token)return;
    nativeFailed=true;stopBuffer();if(view)watch();syncEye();
  }
  function showEye(on:boolean){
    picture.toggleAttribute('data-eye',on);
    view?.mirroring(on||picture.hasAttribute('data-native'));
    if(on)caption('');
  }
  function detachEye(){
    clearTimeout(stall);
    if(frameCallback)video.cancelVideoFrameCallback(frameCallback);
    frameCallback=0;video.pause();video.srcObject=null;showEye(false);
  }
  function syncEye(){
    if(token || !view || !panel.matches(':modal') || !remoteEye || !supportsEye || !surfaceMode){
      if(video.srcObject)detachEye();
      return;
    }
    if(video.srcObject)return;
    const stream=new MediaStream([remoteEye]);video.srcObject=stream;
    const presented=()=>{
      if(video.srcObject!==stream)return;
      showEye(true);
      clearTimeout(stall);stall=window.setTimeout(()=>showEye(false),1100);
      frameCallback=video.requestVideoFrameCallback(presented);
    };
    if(typeof video.requestVideoFrameCallback==='function'){
      frameCallback=video.requestVideoFrameCallback(presented);
      void video.play().catch(()=>{if(video.srcObject===stream)detachEye();});
    }
  }
  let supportsPacked=false,relayTime:number|undefined;
  let id='',began=0,lastAlive=0,stopped=false,timer=0;
  const stop=new AbortController();
  let onlineAt=-Infinity,relayTimer=0,watchRenewed=-Infinity;
  let writes=Promise.resolve(),requestedWatch=false;
  function lease(on:boolean){
    const key=localStorage.getItem('moon.quest.writer');
    if(!key || (!on && !requestedWatch))return;
    requestedWatch=on;watchRenewed=performance.now();
    writes=writes.then(async()=>{if(requestedWatch===on)await castSignal('watch',key,{on});}).catch(()=>{});
  }
  function connected(){
    if(!host.hasAttribute('data-connected')){
      host.dataset.connected='';status.textContent='Quest connected';action.disabled=false;
    }
  }
  function consume(f:SceneFrame,relayed=false) {
    if((f.mode==='globe'||f.mode==='surface') && f.head?.length===7 && f.head.every(Number.isFinite) && Number.isFinite(f.time) &&
      Number.isFinite(f.fov) && (f.mode==='surface'?f.site?.length===2&&f.sun?.length===3:f.pivot?.length===3)){
      const surface=f.mode==='surface' && !relayed;
      if(surface!==surfaceMode){
        surfaceMode=surface;stopBuffer();nativeFailed=false;if(view)watch();
      }
      syncEye();view?.frame(f,relayed);
    }
  }
  async function receiveRelay(){
    const started=performance.now();
    const key=localStorage.getItem('moon.quest.writer');
    try{
      if(key && !host.hidden && !(document.hidden && panel.hidden)){
        const direct=lastAlive>0 && performance.now()-lastAlive<5500;
        if(direct){lease(false);}
        else{
          if(view && performance.now()-watchRenewed>4000)lease(true);
          const state=await castSignal('live',key,{frames:!!view,batched:true,after:relayTime},stop.signal);
          if(state?.online){onlineAt=performance.now();connected();}
          if(view && !(lastAlive && performance.now()-lastAlive<5500)){
            for(const f of state?.history??(state?.frame?[state.frame]:[])){consume(f,true);relayTime=f.time;}
          }
          if(!state?.online && performance.now()-onlineAt>11000){
            delete host.dataset.connected;action.disabled=true;status.textContent='Connecting to Quest…';
            if(view)caption('Reconnecting to Quest…');
          }
        }
      }
    }catch{}
    if(!stopped)relayTimer=window.setTimeout(receiveRelay,view && (!lastAlive||performance.now()-lastAlive>5500)?Math.max(0,65-(performance.now()-started)):1500);
  }
  function reset() {
    stopBuffer();nativeCapable=nativeFailed=false;detachEye();remoteEye=undefined;supportsEye=surfaceMode=false;
    if(ch){ch.onmessage=null;ch.onclose=null;ch.close();ch=undefined;}
    pc?.close();pc=undefined;id='';lastAlive=0;supportsPacked=false;relayTime=undefined;
    if(performance.now()-onlineAt>11000){
      delete host.dataset.connected;action.disabled=true;status.textContent='Connecting to Quest…';
    }
    if(view){watchRenewed=-Infinity;view.reset();}
  }
  function tell(s:string){if(ch?.readyState==='open')ch.send(s);}
  const resize=host.querySelector<HTMLButtonElement>('[aria-label="Resize Quest view"]')!;
  function expand(on:boolean){
    stopBuffer();nativeFailed=false;panel.close();
    host.toggleAttribute('data-large',on);
    if(on)panel.showModal();else panel.show();
    resize.textContent=on?'Restore':'Resize';
    resize.setAttribute('aria-label',on?'Restore compact Quest view':'Resize Quest view');
    resize.setAttribute('aria-pressed',String(on));
    setCastPresentation(on?'expanded':'compact');if(view)watch();syncEye();
    resize.focus({preventScroll:true});
  }
  resize.setAttribute('aria-pressed','false');
  resize.onclick=()=>expand(!panel.matches(':modal'));
  panel.oncancel=e=>{if(panel.matches(':modal')){e.preventDefault();expand(false);}};
  panel.onclick=e=>{
    if(e.target!==panel||!panel.matches(':modal'))return;
    const rect=panel.getBoundingClientRect();
    if(e.clientX<rect.left||e.clientX>rect.right||e.clientY<rect.top||e.clientY>rect.bottom)expand(false);
  };
  function watch(){
    const eye=supportsEye && panel.matches(':modal') && typeof video.requestVideoFrameCallback==='function';
    if(eye && surfaceMode && nativeCapable && !nativeFailed && formats.length){
      if(!token){token=crypto.randomUUID();nativeTimer=window.setTimeout(failBuffer,10000);}
      tell('watch-buffered:'+token+':'+formats.join(','));return;
    }
    tell(eye?'watch-eye':supportsPacked?'watch-packed':'watch');
  }
  function closeView(){
    stopBuffer();nativeFailed=false;detachEye();surfaceMode=false;
    ++viewId;panel.close();panel.hidden=true;host.removeAttribute('data-large');
    resize.textContent='Resize';resize.setAttribute('aria-label','Resize Quest view');resize.setAttribute('aria-pressed','false');
    setCastPresentation('closed');relayTime=undefined;
    if(view){
      view.close();view=undefined;
      const fresh=canvas.cloneNode(false) as HTMLCanvasElement;
      canvas.replaceWith(fresh);canvas=fresh;
    }
    tell('stop');lease(false);
    action.textContent='Cast';action.setAttribute('aria-expanded','false');
  }
  action.setAttribute('aria-expanded','false');
  action.onclick=async()=>{
    if(!panel.hidden){closeView();return;}
    const version=++viewId;panel.hidden=false;panel.show();action.textContent='Stop casting';action.setAttribute('aria-expanded','true');
    caption('Waiting for Quest view…');
    try{
      const {openCastView}=await import('./castView');
      if(viewId!==version)return;
      view=openCastView(canvas,world,caption);setCastPresentation(panel.matches(':modal')?'expanded':'compact');watch();if(!lastAlive)lease(true);
    }catch{caption('Could not open the 3D view. Close and try again.');}
  };
  host.querySelector<HTMLButtonElement>('[aria-label="Close Quest view"]')!.onclick=closeView;
  function peer(key:string) {
    const current=pc=castPeer(),channel=ch=current.createDataChannel('moon-scene',{ordered:false,maxRetransmits:0});
    if(typeof current.addTransceiver==='function' && typeof video.requestVideoFrameCallback==='function'){
      const receiver=current.addTransceiver('video',{direction:'recvonly'}).receiver;
      if('jitterBufferTarget' in receiver){
        try{(receiver as RTCRtpReceiver & {jitterBufferTarget:number}).jitterBufferTarget=260;}catch{}
      }
      current.ontrack=e=>{
        if(current!==pc||e.track.kind!=='video')return;
        remoteEye=e.track;syncEye();
        e.track.onended=()=>{if(remoteEye===e.track){remoteEye=undefined;detachEye();}};
      };
    }
    current.ondatachannel=e=>{
      if(current!==pc || !token || e.channel.label!==nativeChannelPrefix+token){e.channel.close();return;}
      clearTimeout(nativeTimer);
      const active=token;
      closeReader=playBufferedEye(e.channel,buffered,on=>{
        if(on)clearTimeout(nativeTimer);
        showNative(on);
      },()=>{if(active===token)failBuffer();});
      nativeTimer=window.setTimeout(failBuffer,15000);
    };
    channel.binaryType='arraybuffer';
    id=crypto.randomUUID();began=performance.now();
    channel.onopen=()=>{if(current!==pc)return;lastAlive=performance.now();tell('ping');if(view)watch();else tell('stop');};
    channel.onmessage=e=>{
      if(current!==pc)return;
      lastAlive=performance.now();
      connected();
      if(e.data==='supports-buffered'){nativeCapable=true;if(view)watch();syncEye();return;}
      if(token&&e.data==='buffer-failed:'+token){failBuffer();return;}
      if(e.data==='supports-eye'){supportsEye=true;if(view)watch();syncEye();return;}
      if(e.data==='supports-packed'){supportsPacked=true;if(view)watch();return;}
      if(e.data==='alive'||!view)return;
      try{
        if(e.data instanceof ArrayBuffer && e.data.byteLength<=65536)consume(unpack(e.data));
        else if(typeof e.data==='string' && e.data.length<=65536)consume(JSON.parse(e.data));
      }catch{ /* Drop damaged frames and keep the live connection. */ }
    };
    channel.onclose=()=>{if(pc===current)reset();};
    return localSDP(current,'offer').then(sdp=>pc===current?castSignal('offer',key,{id,sdp},stop.signal):null);
  }
  async function poll(){
    if(stopped)return;
    const key=localStorage.getItem('moon.quest.writer');
    try{
      if(key && !host.hidden && !(document.hidden && panel.hidden)){
        if(pc && (pc.connectionState==='failed'||(lastAlive?performance.now()-lastAlive>9500:performance.now()-began>30000)))reset();
        if(!pc)await peer(key);
        else if(ch?.readyState==='open'){tell('ping');if(view)watch();else tell('stop');}
        else if(pc.signalingState==='have-local-offer'){
          const current=pc,state=await castSignal('status',key,{},stop.signal);
          if(pc===current && state?.id===id && state.answer)await current.setRemoteDescription({type:'answer',sdp:state.answer});
        }
      }
    }catch{if(!stopped&&!lastAlive)reset();}
    if(!stopped)timer=window.setTimeout(poll,lastAlive?1750:1200);
  }
  void receiveRelay();
  if(typeof RTCPeerConnection!=='undefined')void poll();
  function dispose(){stopped=true;hudSize.disconnect();clearTimeout(timer);clearTimeout(relayTimer);stop.abort();closeView();reset();host.remove();style.remove();}
  window.addEventListener('pagehide',e=>{if(!e.persisted)dispose();},{once:true});
  return {hide:()=>{host.hidden=true;closeView();},show:()=>{host.hidden=false;}};
}
