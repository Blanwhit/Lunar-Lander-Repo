// H.264 Annex B and VP8 keyframes carry the decoder initialization in-band.
const codecs:Record<string,string>={avc:'avc1.420033',vp8:'vp8'};
export const nativeChannelPrefix='moon-eye/';
export async function playableEyes(){
  if(typeof VideoDecoder==='undefined')return [];
  const keys=Object.keys(codecs);
  const supported=await Promise.all(keys.map(async k=>{
    try{return (await VideoDecoder.isConfigSupported({codec:codecs[k]})).supported;}catch{return false;}
  }));
  return keys.filter((_,i)=>supported[i]);
}

export function createEyeWriter(channel:RTCDataChannel,keys:string[],fail:()=>void){
  let encoder:VideoEncoder|undefined,epoch=0,width=0,height=0,bitrate=0;
  let nextKey=0,lastPressure=0,needsKey=true,frameLimit=60;
  function stop(){
    epoch++;if(encoder&&encoder.state!=='closed')encoder.close();encoder=undefined;width=height=0;frameLimit=60;
  }
  async function start(w:number,h:number,fps:number){
    stop();const id=epoch;width=w;height=h;nextKey=lastPressure=0;needsKey=true;
    bitrate=Math.round(Math.min(45_000_000,Math.max(3_000_000,w*h*fps*.24)));
    try{
      let config:VideoEncoderConfig|undefined;
      // Prefer a hardware encoder at the actual eye size. VP8 is the fallback
      // when a browser only has software codecs for these dimensions.
      const choices=keys.map(key=>({key,hardwareAcceleration:'prefer-hardware' as VideoEncoderConfig['hardwareAcceleration']}))
        .concat([...keys].sort((a,b)=>Number(b==='vp8')-Number(a==='vp8')).map(key=>({key,hardwareAcceleration:'no-preference' as VideoEncoderConfig['hardwareAcceleration']})));
      for(const {key,hardwareAcceleration} of choices){
        const codec=codecs[key];if(!codec)continue;
        const framerate=hardwareAcceleration==='prefer-hardware'?fps:Math.min(24,fps);
        const candidate:VideoEncoderConfig={codec,width:w,height:h,framerate,bitrate,
          hardwareAcceleration,latencyMode:'realtime',bitrateMode:'constant',...(key==='avc'?{avc:{format:'annexb' as const}}:{})};
        if((await VideoEncoder.isConfigSupported(candidate)).supported){config=candidate;break;}
      }
      if(id!==epoch)return;
      if(!config)throw new Error('No shared native-eye codec');
      const selected=config;
      frameLimit=config.hardwareAcceleration==='prefer-hardware'?60:24;
      const enc=encoder=new VideoEncoder({
        error:()=>{if(id===epoch)fail();},
        output:chunk=>{
          if(id!==epoch||channel.readyState!=='open')return;
          try{
            // Retain short motion bursts. For a sustained deficit, discard a whole
            // dependency chain and restart at a keyframe with the same dimensions.
            if(channel.bufferedAmount>Math.max(400_000,bitrate/8*.85)){
              if(!lastPressure)lastPressure=performance.now();
              if(performance.now()-lastPressure>600){
                bitrate=Math.max(4_000_000,Math.round(bitrate*.78));
                enc.configure({...selected,bitrate});lastPressure=performance.now();
              }
              nextKey=0;needsKey=true;return;
            }
            if(needsKey && chunk.type!=='key')return;
            needsKey=false;
            if(channel.bufferedAmount<bitrate/8*.25)lastPressure=0;
            const bytes=new Uint8Array(chunk.byteLength);chunk.copyTo(bytes);
            channel.send(JSON.stringify({type:chunk.type,time:chunk.timestamp,bytes:bytes.length}));
            for(let offset=0;offset<bytes.length;offset+=16384)channel.send(bytes.subarray(offset,offset+16384));
          }catch{fail();}
        },
      });
      enc.configure(config);
      channel.send(JSON.stringify({type:'begin',codec:selected.codec,width:w,height:h}));
    }catch{if(id===epoch)fail();}
  }
  return {
    get frameLimit(){return frameLimit;},
    canCapture(){return !encoder || encoder.encodeQueueSize<2;},
    draw(canvas:HTMLCanvasElement,time:number,fps:number){
      if(channel.readyState!=='open')return;
      if(width!==canvas.width||height!==canvas.height){void start(canvas.width,canvas.height,fps);return;}
      if(!encoder||encoder.state!=='configured'||encoder.encodeQueueSize>=2)return;
      const timestamp=Math.round(time*1000);
      const frame=new VideoFrame(canvas,{timestamp});
      try{
        const keyFrame=timestamp>=nextKey || !nextKey;
        encoder.encode(frame,{keyFrame});
        if(keyFrame)nextKey=timestamp+900000;
      }catch{fail();}finally{frame.close();}
    },
    idle(){stop();if(channel.readyState==='open')channel.send('idle');},
    close(){stop();channel.close();},
  };
}

// Store the one-second reserve as compressed frames. Keep only a few decoded
// frames ahead of the display clock to bound GPU memory at Quest eye resolution.
export function playBufferedEye(channel:RTCDataChannel,canvas:HTMLCanvasElement,visible:(on:boolean)=>void,failed:()=>void){
  const ctx=canvas.getContext('2d',{alpha:false});
  channel.binaryType='arraybuffer';
  let decoder:VideoDecoder|undefined,queue:EncodedVideoChunk[]=[],ready:VideoFrame[]=[];
  let id=0,raf=0,watchdog=0,width=0,height=0,outstanding=0,queuedBytes=0;
  let bytes:Uint8Array<ArrayBuffer>|undefined,used=0,type:EncodedVideoChunkType='key',time=0;
  let newest=-Infinity,origin=NaN,started=NaN,lastShown=-Infinity,needKey=true;
  let discardBefore=-Infinity;
  function clear(){
    id++;clearTimeout(watchdog);cancelAnimationFrame(raf);raf=0;
    if(decoder&&decoder.state!=='closed')decoder.close();decoder=undefined;
    for(const f of ready)f.close();
    ready=[];queue=[];queuedBytes=outstanding=0;bytes=undefined;used=0;
    origin=started=NaN;newest=lastShown=-Infinity;needKey=true;discardBefore=-Infinity;
    visible(false);
  }
  function tick(now:number){
    raf=requestAnimationFrame(tick);if(!ctx||!decoder)return;
    try{
      if(!Number.isFinite(started)&&Number.isFinite(origin)&&newest-origin>=900000)started=now;
      const cursor=Number.isFinite(started)?origin+(now-started)*1000:origin;
      // Skip stale work if the desktop tab was suspended. Resume on an independent frame.
      if(newest-cursor>2600000){
        const key=queue.findIndex(c=>c.type==='key' && c.timestamp>=newest-1500000);
        if(key>=0){
          for(const c of queue.splice(0,key))queuedBytes-=c.byteLength;
          for(const f of ready)f.close();ready=[];discardBefore=origin=queue[0].timestamp;started=NaN;return;
        }
      }
      while(queue.length && ready.length+outstanding<6 && queue[0].timestamp<=cursor+180000){
        const c=queue.shift()!;queuedBytes-=c.byteLength;outstanding++;decoder.decode(c);
      }
      if(!Number.isFinite(started))return;
      let frame:VideoFrame|undefined;
      while(ready.length && ready[0].timestamp<=cursor){frame?.close();frame=ready.shift();}
      if(frame){
        try{
          if(frame.displayWidth!==width||frame.displayHeight!==height)throw new Error('Unexpected eye resolution');
          if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
          ctx.drawImage(frame,0,0);lastShown=frame.timestamp;visible(true);
        }finally{frame.close();}
      }
      if(Number.isFinite(lastShown)&&cursor-newest>180000){origin=newest;started=NaN;}
    }catch{failed();}
  }
  function begin(codec:string,w:number,h:number){
    clear();width=w;height=h;const current=id;
    decoder=new VideoDecoder({output:f=>{
      if(current!==id){f.close();return;}
      outstanding--;
      if(f.timestamp<discardBefore)f.close();else ready.push(f);
    },error:()=>{if(id===current)failed();}});
    decoder.configure({codec,codedWidth:w,codedHeight:h,optimizeForLatency:true});
    raf=requestAnimationFrame(tick);
  }
  channel.onmessage=e=>{
    try{
      if(e.data==='idle'){clear();return;}
      if(typeof e.data==='string'){
        const m=JSON.parse(e.data);
        if(m.type==='begin'&&Object.values(codecs).includes(m.codec)&&
          [m.width,m.height].every(v=>Number.isInteger(v)&&v>0&&v<=8192))begin(m.codec,m.width,m.height);
        else if(decoder&&!bytes&&(m.type==='key'||m.type==='delta')&&Number.isSafeInteger(m.time)&&
          m.time>=0&&Number.isInteger(m.bytes)&&m.bytes>0&&m.bytes<=12_000_000){
          type=m.type;time=m.time;bytes=new Uint8Array(m.bytes);used=0;
        }else throw new Error('Invalid eye frame');
        clearTimeout(watchdog);watchdog=window.setTimeout(failed,6500);
      }else if(e.data instanceof ArrayBuffer && bytes && used+e.data.byteLength<=bytes.length){
        bytes.set(new Uint8Array(e.data),used);used+=e.data.byteLength;
        if(used===bytes.length){
          if((!needKey||type==='key') && time>newest){
            needKey=false;if(!Number.isFinite(origin))origin=time;
            queue.push(new EncodedVideoChunk({type,timestamp:time,data:bytes}));newest=time;queuedBytes+=used;
            if(queuedBytes>32_000_000||queue.length>240)throw new Error('Eye buffer overrun');
          }
          bytes=undefined;
        }
      }else throw new Error('Invalid eye packet');
    }catch{failed();}
  };
  channel.onclose=channel.onerror=failed;
  return ()=>{channel.onclose=channel.onerror=channel.onmessage=null;channel.close();clear();canvas.width=canvas.height=1;};
}
