import { shareQuest } from './castLink';
export type SurfacePoint = {lat:number; lon:number};
export type Visit = (point:SurfacePoint) => Promise<boolean>;
export type Listen = (visit:Visit) => void;
type Packet = {target:SurfacePoint; revision:string; arrived:boolean; feasibility?:boolean; feasibilityRevision?:string; code?:string};

type SavedComputer = {roomKey:string; target:SurfacePoint; revision:string};
export type QuestConnection = {pin:string} | SavedComputer;
const computerKey = 'moon.quest.computer';

export function savedComputer(): SavedComputer | undefined {
  try {
    const saved = JSON.parse(localStorage.getItem(computerKey) ?? 'null');
    if (saved && /^[A-HJ-NP-Z2-9]{10}$/.test(saved.roomKey) && typeof saved.revision==='string'
        && Number.isFinite(saved.target?.lat) && Number.isFinite(saved.target?.lon)) return saved;
  } catch { /* A new pairing can replace an unreadable record. */ }
}

async function request<T = Packet>(action:string, key:string, body?:unknown, signal?:AbortSignal):Promise<T> {
  const res = await fetch('/api/quest/'+action, {
    method:'POST', headers:{Authorization:'Bearer '+key, 'Content-Type':'application/json'},
    body:JSON.stringify(body ?? {}), cache:'no-store', signal,
  });
  if (res.status===404) throw new MissingRoom();
  if (!res.ok) throw new Error(res.status===503 ? 'The connection is busy. Please try again.' : 'Could not reach the headset connection. Try again.');
  return res.json();
}

class MissingRoom extends Error {
  constructor(){super('No current location. Click Land on the computer to send one. For a new pairing, use the code shown there.');}
}

export class QuestHandoff {
  private panel = document.createElement('dialog');
  private message = document.createElement('p');
  private code = document.createElement('strong');
  private form = document.createElement('form');
  private input = document.createElement('input');
  private connect = document.createElement('button');
  private showCode = document.createElement('button');
  private sent = 0;
  constructor(private open:(connection:QuestConnection)=>Promise<void>) {
    const style=document.createElement('style');
    style.textContent=`
      .quest-pair{color:#e6edf1;background:#122027;border:1px solid #536976;border-radius:14px;padding:24px;width:min(340px,78vw);font:15px/1.5 system-ui}
      .quest-pair[data-sending]{position:fixed;inset:auto 12px 12px auto;margin:0;z-index:10000}.quest-pair[data-sending] h2{font-size:16px}.quest-pair[data-sending] p{margin:5px 0}.quest-pair::backdrop{background:#0009}.quest-pair h2{margin:0;font-size:20px}.quest-pair strong{display:block;font:600 26px monospace;letter-spacing:.1em}
      .quest-pair input,.quest-pair button{font:inherit;border-radius:6px;padding:7px 10px}.quest-pair input{width:12ch;text-transform:uppercase}.quest-pair button{margin:6px 6px 0 0;cursor:pointer}
    `;
    this.panel.className='quest-pair';
    const title=document.createElement('h2');title.textContent='Connect your Quest';title.id='quest-pair-title';
    this.panel.setAttribute('aria-labelledby',title.id);
    this.message.setAttribute('role','status');
    this.input.placeholder='Pairing code';this.input.setAttribute('aria-label','Pairing code');
    this.input.autocomplete='one-time-code';this.input.spellcheck=false;this.input.inputMode='numeric';this.input.maxLength=3;this.input.pattern='[0-9]{3}';
    this.connect.textContent='Connect Quest';this.connect.type='submit';
    this.form.append(this.input,this.connect);
    this.form.onsubmit=async e=>{
      e.preventDefault();
      const code=this.input.value.trim();
      if(!/^\d{3}$/.test(code)){this.message.textContent='Enter the 3-digit code shown on your computer.';return;}
      this.connect.disabled=true;
      try{await this.open({pin:code});this.panel.close();}
      catch(err){this.message.textContent=err instanceof Error?err.message:'Could not enter VR.';}
      finally{this.connect.disabled=false;}
    };
    const close=document.createElement('button');close.textContent='Close';close.onclick=()=>this.panel.close();
    this.showCode.type='button';this.showCode.textContent='Pair another Quest';this.showCode.hidden=true;
    this.panel.append(title,this.message,this.code,this.form,this.showCode,close);
    document.head.append(style);document.body.append(this.panel);
  }
  async resumeOrPair() {
    const saved=savedComputer();
    if(!saved){this.pair();return;}
    try{await this.open(saved);}
    catch(err){this.pair();this.message.textContent=err instanceof Error?err.message:'Could not resume VR.';}
  }
  pair() {
    if(this.panel.open)this.panel.close();
    delete this.panel.dataset.sending;
    this.showCode.hidden=true;
    this.form.hidden=false;this.code.textContent='';
    this.message.textContent='Enter the code shown on your computer, then start VR on this headset.';
    this.input.value='';
    if(!this.panel.open)this.panel.showModal();
    this.input.focus();
  }
  private pendingFeasibility?:boolean;
  private writingFeasibility=false;
  setFeasibility(enabled:boolean) {
    const key=localStorage.getItem('moon.quest.writer');
    if(!key) return;
    this.pendingFeasibility=enabled;
    if(this.writingFeasibility) return;
    this.writingFeasibility=true;
    const flush=async()=>{
      while(this.pendingFeasibility!==undefined) {
        const value=this.pendingFeasibility;
        this.pendingFeasibility=undefined;
        try {await request('feasibility',key,{enabled:value});}
        catch(error){
          if(error instanceof MissingRoom) continue; // The next Land includes the current switch.
          this.pendingFeasibility??=value;
          await new Promise(resolve=>setTimeout(resolve,3500));
        }
      }
      this.writingFeasibility=false;
    };
    void flush();
  }
  async send(point:SurfacePoint, getFeasibility:()=>boolean) {
    const attempt=++this.sent;
    const keyName='moon.quest.writer';
    let key=localStorage.getItem(keyName) ?? sessionStorage.getItem(keyName);
    if(!key){key=Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');}
    localStorage.setItem(keyName,key);
    const remembered = localStorage.getItem('moon.quest.pairedWriter')===key;
    this.showCode.hidden=true;
    this.form.hidden=true;this.code.textContent='';this.message.textContent='Sending the selected point…';
    this.panel.dataset.sending='';
    if(!this.panel.open)this.panel.show();
    try{
      const feasibility=getFeasibility();
      const packet=await request('send',key,{...point,shortCode:!remembered,feasibility});
      if(attempt!==this.sent)return;
      if(feasibility!==getFeasibility())this.setFeasibility(getFeasibility());
      const displayCode=(pin:string)=>{
        this.code.textContent=pin;
        this.message.textContent='On your Quest, choose Connect to computer and enter this code. Moon will remember the connection.';
        this.showCode.hidden=true;
      };
      if(remembered){
        this.message.textContent='Landing sent to your Quest.';
        this.showCode.hidden=false;
        this.showCode.onclick=async ()=>{
          try {
            const result=await request<{code:string}>('pin',key);
            if(attempt===this.sent)displayCode(result.code);
          }catch{if(attempt===this.sent)this.message.textContent='Could not get a pairing code. Try again.';}
        };
      }else displayCode(packet.code!);
      const deadline=performance.now()+10*60_000;
      while(attempt===this.sent && performance.now()<deadline) {
        await new Promise(r=>setTimeout(r,1600));
        if(attempt!==this.sent)return;
        const latest=await request('status',key);
        if(latest.revision!==packet.revision)return;
        if(latest.arrived){localStorage.setItem('moon.quest.pairedWriter',key);if(this.panel.dataset.sending!==undefined)this.panel.close();return;}
      }
    }catch(err){if(attempt===this.sent)this.message.textContent=err instanceof Error?err.message:'Could not send the point.';}
  }
}

export async function receiveQuest(connection:QuestConnection, signal:AbortSignal, first:(p:SurfacePoint,listen:Listen)=>Promise<void>, applyFeasibility:(enabled:boolean)=>void) {
  let visit:Visit|undefined;
  const roomKey='pin' in connection
    ? (await request<{roomKey:string}>('join',connection.pin,undefined,signal)).roomKey
    : connection.roomKey;
  shareQuest(roomKey,signal);
  let packet: Pick<Packet,'target'|'revision'|'feasibility'|'feasibilityRevision'>;
  try {packet=await request('receive',roomKey,undefined,signal);}
  catch(error){
    // A destination expires after eight hours. A remembered computer can send a fresh
    // destination into this same room whenever it reopens Moon.
    if(!(error instanceof MissingRoom) || 'pin' in connection)throw error;
    packet=connection;
  }
  const remember=(state:Pick<Packet,'target'|'revision'>)=>{
    localStorage.setItem(computerKey,JSON.stringify({roomKey,target:state.target,revision:state.revision}));
  };
  let lastSetting:string|undefined;
  const applySetting=(state:typeof packet)=>{
    if(typeof state.feasibility==='boolean' && state.feasibilityRevision!==lastSetting){
      applyFeasibility(state.feasibility);
      lastSetting=state.feasibilityRevision;
    }
  };
  applySetting(packet);
  await first(packet.target,fn=>{visit=fn;});
  if(signal.aborted)return;
  remember(packet);
  let revision=packet.revision;
  // Acknowledge only once the actual surface is ready. Retry network failures in this session.
  let ack=true;
  async function poll() {
    if(signal.aborted)return;
    try {
      if(ack){
        try{await request('arrived',roomKey,{revision},signal);}
        catch(error){if(!(error instanceof MissingRoom))throw error;}
        ack=false;
      }
      const next=await request('receive',roomKey,undefined,signal);
      applySetting(next);
      if(next.revision!==revision && visit && await visit(next.target)){
        remember(next);revision=next.revision;ack=true;
      }
    } catch { /* Recover after Wi-Fi or headset sleep. */ }
    if(!signal.aborted)setTimeout(poll,ack?300:1400);
  }
  void poll();
}
