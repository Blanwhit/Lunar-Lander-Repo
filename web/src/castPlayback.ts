// Compare times only within a device's own clock. The minimum transit offset maps the
// headset timeline to the spectator clock without following each packet's arrival jitter.
export class CastPlayback {
  private offset=NaN;
  private arrival=-Infinity;
  private gap=0;
  private cursor=NaN;

  reset(){
    this.offset=this.cursor=NaN;
    this.arrival=-Infinity;
    this.gap=0;
  }

  receive(sender:number,now:number){
    const gap=now-this.arrival;
    if(Number.isFinite(gap) && gap>2){
      // Respond to a burst gap quickly, then decay over several seconds.
      this.gap=Math.max(Math.min(500,gap),this.gap*Math.exp(-gap/4500));
    }
    this.arrival=now;
    const transit=now-sender;
    this.offset=Number.isFinite(this.offset)?Math.min(transit,this.offset+Math.min(2,gap*.002)):transit;
  }

  sample(now:number,elapsed:number,latest:number,relayed:boolean,expanded=false){
    const reserve=(relayed?Math.max(300,this.gap+75):Math.max(160,this.gap+40))+(expanded?95:0);
    const target=now-this.offset-reserve;
    if(!Number.isFinite(this.cursor)||elapsed>600||Math.abs(target-this.cursor)>1000){
      this.cursor=target;
    }else{
      const next=this.cursor+elapsed;
      // Recover buffer depth gradually so regular head turns retain a steady speed.
      this.cursor=next+Math.max(-elapsed*.06,Math.min(elapsed*.06,(target-next)*.08));
    }
    this.cursor=Math.min(latest,this.cursor);
    return this.cursor;
  }
}

// Measure a window of presented frames before spending more pixels. Keep an
// inexpensive resize frame and back off quickly when additional pixels cost motion.
export class CastResolution {
  private pixels=360*225;
  private limit=0;
  private expanded=false;
  private since=0;
  private intervals:number[]=[];
  private reference=Infinity;
  private retryAfter=0;
  private lastGood=64000;

  reset(){
    this.since=0;this.intervals.length=0;
    this.reference=Infinity;this.retryAfter=0;this.pixels=360*225;this.lastGood=64000;
  }
  layout(pixels:number,expanded:boolean){
    if(expanded!==this.expanded){
      this.pixels=Math.min(360*225,this.pixels);this.lastGood=this.pixels;
      this.since=0;this.intervals.length=0;this.retryAfter=0;this.reference=Infinity;
    }
    this.expanded=expanded;this.limit=Math.max(4,pixels);
  }
  scale(now:number,interval:number){
    if(!this.since)this.since=now;
    this.intervals.push(interval);
    if(now-this.since>=550 && this.intervals.length>=5){
      const samples=this.intervals.sort((a,b)=>a-b);
      const median=samples[Math.floor(samples.length*.5)];
      const tail=samples[Math.floor(samples.length*.85)];
      // Learn the achievable cadence in compact mode or at the initial pixel budget.
      if((!this.expanded || this.pixels<=360*225) && tail<median*1.45+2){
        const steady=Math.max(16.7,median);
        this.reference=Number.isFinite(this.reference)?this.reference+(steady-this.reference)*.4:steady;
      }
      const target=Math.min(160,Math.max(18,this.reference));
      if(!Number.isFinite(this.reference)){
        // Ignore program compilation and the initial pipeline fill.
      }else if(median>target*1.12+1 || tail>target*1.45+2){
        this.pixels=Math.max(64000,Math.min(this.lastGood,Math.round(this.pixels*.82)));
        this.lastGood=this.pixels;
        this.retryAfter=now+4200;
      }else if(now>=this.retryAfter && median<=target*1.06+1 && tail<=target*1.35+1){
        this.lastGood=this.pixels;
        const cap=this.expanded?2560*1440:360*225;
        this.pixels=Math.min(this.limit,cap,Math.round(this.pixels*1.46));
        this.retryAfter=now+950;
      }
      this.since=now;this.intervals.length=0;
    }
    return Math.min(1,Math.sqrt(this.pixels/this.limit));
  }
}
