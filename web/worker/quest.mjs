// A computer owns the write key. The shorter pairing code lets its headset receive locations.
const lifetime = 8 * 3600_000;
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const reply = (body, status = 200) => Response.json(body, {
  status, headers: { 'Cache-Control': 'no-store' },
});
async function writeCode(secret) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)));
  return Array.from(bytes.slice(0,10), byte => alphabet[byte % alphabet.length]).join('');
}
// A PIN is only used to join. The headset keeps the room key for subsequent transfers,
// so recycling a PIN cannot move an already paired headset into another person's room.
const pinPrefix = 'quest-pins/';
const pinLifetime = 10 * 60_000;

async function reservePin(bucket, roomKey) {
  const slots = new Map();
  let cursor;
  do {
    const page = await bucket.list({prefix:pinPrefix,limit:1000,cursor,include:['customMetadata']});
    for(const slot of page.objects)slots.set(slot.key.slice(pinPrefix.length),slot);
    cursor = page.truncated ? page.cursor : undefined;
  } while(cursor);
  const bytes = crypto.getRandomValues(new Uint32Array(1));
  const start = bytes[0] % 1000;
  const candidates = Array.from({length:1000}, (_,i)=>String((start+i)%1000).padStart(3,'0'));
  const previous = [...slots.values()].find(slot=>slot.customMetadata?.roomKey===roomKey);
  if(previous)candidates.unshift(previous.key.slice(pinPrefix.length));
  for(const pin of candidates){
    const slot = slots.get(pin);
    if(slot && slot.customMetadata?.roomKey!==roomKey && Number(slot.customMetadata?.expires)>Date.now())continue;
    const expires = Date.now()+pinLifetime;
    const result = await bucket.put(pinPrefix+pin,JSON.stringify({roomKey,expires}),{
      customMetadata:{roomKey,expires:String(expires)},
      onlyIf:slot ? {etagMatches:slot.etag} : {etagDoesNotMatch:'*'},
    });
    if(result)return pin;
  }
  return null;
}

function validSignal(body) {
  return /^[a-f0-9-]{36}$/.test(body?.id) && typeof body.sdp==='string' && body.sdp.length<=24000 && body.sdp.startsWith('v=0');
}

function publicState(room) {
  return { target: room.target, revision: room.revision, arrived: room.arrived, feasibility: room.feasibility, feasibilityRevision: room.feasibilityRevision };
}
export async function questHandoff(request, bucket) {
  if (request.method !== 'POST') return reply({error:'Use POST.'},405);
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) return reply({error:'Origin mismatch.'},403);
  const action = new URL(request.url).pathname.split('/').pop();
  const key = request.headers.get('Authorization')?.replace(/^Bearer /,'') ?? '';
  if (action === 'join') {
    if (!/^\d{3}$/.test(key)) return reply({error:'Enter three digits.'},400);
    const slot = await bucket.get(pinPrefix+key);
    const lease = slot && await slot.json();
    if(!lease || lease.expires <= Date.now()) return reply({error:'Pairing code expired or incorrect.'},404);
    return reply({roomKey:lease.roomKey});
  }
  if (['cast-presence','cast-watch','cast-live','cast-frame'].includes(action)) {
    const sender=action==='cast-watch'||action==='cast-live';
    if(!(sender?/^[a-f0-9]{64}$/:/^[A-HJ-NP-Z2-9]{10}$/).test(key)) return reply({},403);
    const room=sender?await writeCode(key):key;
    const path=(suffix,day=0)=>'quest-handoffs/'+new Date(Date.now()+day*86400_000).toISOString().slice(0,10)+'/'+room+'.'+suffix;
    async function recent(suffix,age){
      const now=Date.now();
      const item=await bucket.get(path(suffix)) ?? (now%86400_000<age?await bucket.get(path(suffix,-1)):null);
      const data=item && await item.json();
      return data && now-data.at<age?data:null;
    }
    if(action==='cast-presence'){
      const [,watch]=await Promise.all([bucket.put(path('presence'),JSON.stringify({at:Date.now()})),recent('watch',14000)]);
      return reply({watch:!!watch?.on});
    }
    if(action==='cast-watch'){
      const {on}=await request.json();
      if(typeof on!=='boolean')return reply({},400);
      await bucket.put(path('watch'),JSON.stringify({on,at:Date.now()}));
      if(!on)await bucket.delete(path('pose'));
      return reply({ok:true});
    }
    if(action==='cast-frame'){
      const raw=await request.text();
      if(raw.length>240000)return reply({},413);
      const payload=JSON.parse(raw);
      const history=payload.history??[payload];
      if(!Array.isArray(history)||!history.length||history.length>12||history.some(f=>
        !['globe','surface'].includes(f?.mode)||!Number.isFinite(f.time)||f.head?.length!==7))return reply({},400);
      if(!(await recent('watch',14000))?.on)return reply({watch:false});
      await bucket.put(path('pose'),JSON.stringify({at:Date.now(),history}));
      return reply({watch:true});
    }
    const {frames,batched,after}=await request.json();
    const [presence,pose]=await Promise.all([recent('presence',12000),frames?recent('pose',3000):null]);
    const history=pose?.history??(pose?.frame?[pose.frame]:[]);
    const frame=history.at(-1);
    if(!batched)return reply({online:!!presence,frame});
    const fresh=Number.isFinite(after)&&frame?.time>=after?history.filter(f=>f.time>after):history;
    return reply({online:!!presence,history:fresh});
  }
  if (action.startsWith('cast-')) {
    const writer=/^[a-f0-9]{64}$/.test(key), headset=/^[A-HJ-NP-Z2-9]{10}$/.test(key);
    if (!(action==='cast-status' ? writer || headset : action==='cast-offer' ? writer : action==='cast-answer' && headset))
      return reply({error:'Invalid cast credentials.'},403);
    const room=writer?await writeCode(key):key;
    const keyOnDay=d=>'quest-handoffs/'+new Date(Date.now()+d*86400_000).toISOString().slice(0,10)+'/'+room+'.cast';
    let path=keyOnDay(0);
    if(action==='cast-offer'){
      const body=await request.json();
      if(!validSignal(body))return reply({},400);
      const state={id:body.id,offer:body.sdp,expires:Date.now()+65000};
      await bucket.put(path,JSON.stringify(state));return reply({id:state.id});
    }
    let record=await bucket.get(path);
    if(!record){path=keyOnDay(-1);record=await bucket.get(path);}
    const state=record && await record.json();
    if(!state || state.expires<Date.now())return action==='cast-status'?reply(null):reply({},404);
    if(action==='cast-status')return reply(state);
    const body=await request.json();
    if(!validSignal(body))return reply({},400);
    if(body.id!==state.id)return reply({},409);
    state.answer=body.sdp;
    const ok=await bucket.put(path,JSON.stringify(state),{onlyIf:{etagMatches:record.etag}});
    return reply({id:state.id},ok?200:409);
  }
  if (!['send','receive','arrived','status','pin','feasibility'].includes(action)) return reply({},404);
  const sender = action === 'send' || action === 'status' || action === 'pin' || action === 'feasibility';
  if (!(sender ? /^[a-f0-9]{64}$/ : /^[A-HJ-NP-Z2-9]{10}$/).test(key)) return reply({error:'Invalid pairing key.'},400);
  const code = sender ? await writeCode(key) : key;
  const prefix = 'quest-handoffs/';
  const day = delta => new Date(Date.now()+delta*86400_000).toISOString().slice(0,10);
  const keyFor = delta => prefix+day(delta)+'/'+code;
  let path = keyFor(0);
  if (action === 'send') {
    const body = await request.json().catch(()=>null);
    const {lat,lon} = body ?? {};
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat)>90 || Math.abs(lon)>180)
      return reply({error:'Select a point on the Moon.'},400);
    const pairingCode = body.shortCode ? await reservePin(bucket,code) : code;
    if(!pairingCode)return reply({error:'All pairing codes are in use. Try again shortly.'},503);
    const next = {target:{lat,lon}, revision:crypto.randomUUID(), arrived:false, expires:Date.now()+lifetime};
    if (typeof body.feasibility === 'boolean') {
      next.feasibility=body.feasibility;
      next.feasibilityRevision=next.revision;
    }
    await bucket.put(path,JSON.stringify(next));
    // Date-ordered keys allow bounded cleanup without scanning current sessions.
    const oldest = await bucket.list({prefix,limit:32});
    const expired = oldest.objects.filter(o => o.key < prefix+day(-1)+'/').map(o=>o.key);
    if(expired.length) await bucket.delete(expired);
    return reply({code:pairingCode,...publicState(next)});
  }
  let object = await bucket.get(path);
  if(!object){path=keyFor(-1);object=await bucket.get(path);}
  const room = object && await object.json();
  if (!room || room.expires <= Date.now()) return reply({error:'Pairing code expired or incorrect.'},404);
  if (action === 'pin') {
    const pin = await reservePin(bucket,code);
    return pin ? reply({code:pin}) : reply({error:'All pairing codes are in use.'},503);
  }
  if (action === 'arrived' || action === 'feasibility') {
    const body = await request.json().catch(()=>null);
    if (action==='feasibility' && typeof body?.enabled!=='boolean') return reply({error:'Expected an on/off setting.'},400);
    for (let attempt=0; attempt<4; attempt++) {
      const current=attempt===0 ? room : await object.json();
      if (action==='arrived') {
        if(current.revision!==body?.revision || current.arrived) return reply(publicState(current));
        current.arrived=true;
      } else {
        current.feasibility=body.enabled;
        current.feasibilityRevision=crypto.randomUUID();
      }
      if(await bucket.put(path,JSON.stringify(current),{onlyIf:{etagMatches:object.etag}})) return reply(publicState(current));
      object=await bucket.get(path);
      if(!object) return reply({error:'Connection expired.'},404);
    }
    return reply({error:'Please retry the setting.'},503);
  }
  return reply(publicState(room));
}
