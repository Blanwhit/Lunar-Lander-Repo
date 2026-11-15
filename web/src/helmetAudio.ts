import { sprintSpeed, walkSpeed } from './walkGait';

// All sources are heard inside the suit: ventilation, the wearer's breath and
// impacts conducted from the soles. The exterior has no acoustic ambience.
function gain(context: AudioContext, level: number, output: AudioNode) {
  const node = context.createGain();
  node.gain.value = level;
  node.connect(output);
  return node;
}

function filter(context: AudioContext, type: BiquadFilterType, hz: number, q: number, output: AudioNode) {
  const node = context.createBiquadFilter();
  node.type = type;
  node.frequency.value = hz;
  node.Q.value = q;
  node.connect(output);
  return node;
}

function makeNoise(context: AudioContext) {
  const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * 2.7), context.sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < channel.length; i++) channel[i] = Math.random() * 2 - 1;
  return buffer;
}

function makeHelmet(context: AudioContext) {
  const output = gain(context, .65, context.destination);
  const noise = makeNoise(context);
  const air = context.createBufferSource();
  air.buffer = noise;
  air.loop = true;
  const fan = filter(context, 'lowpass', 560, .65, gain(context, .13, output));
  air.connect(filter(context, 'highpass', 90, .65, fan));
  const motor = context.createOscillator();
  motor.frequency.value = 173;
  motor.connect(gain(context, .004, output));
  motor.start();

  // Inspiration has more high-frequency airflow; expiration is lower and longer.
  const inhale = gain(context, 0, output), exhale = gain(context, 0, output);
  const intake = filter(context, 'bandpass', 800, .8, inhale);
  const exhaust = filter(context, 'bandpass', 490, .78, exhale);
  air.connect(intake);
  air.connect(exhaust);
  air.start();
  return { output, noise, inhale, exhale, intake, exhaust };
}

function airflow(level: AudioParam, start: number, duration: number, peak: number, expiration: boolean) {
  level.setValueAtTime(.0001, start);
  level.linearRampToValueAtTime(peak * .30, start + duration * .16);
  level.linearRampToValueAtTime(peak, start + duration * (expiration ? .38 : .50));
  level.linearRampToValueAtTime(peak * .66, start + duration * .71);
  level.exponentialRampToValueAtTime(.0001, start + duration);
}

export class HelmetAudio {
  private context?: AudioContext;
  private helmet?: ReturnType<typeof makeHelmet>;
  private active = false;
  private disposed = false;
  private exertion = 0;
  private recentEffort = 0;
  private nextBreath = 0;

  /** Call within a walk/VR user gesture so the browser can unlock audio. */
  start() {
    if (this.disposed || typeof AudioContext === 'undefined') return;
    try {
      if (!this.context) {
        this.context = new AudioContext({ latencyHint: 'interactive' });
        this.helmet = makeHelmet(this.context);
      }
      this.active = true;
      if (this.context.state !== 'running') void this.context.resume().catch(() => {});
    } catch {
      this.active = false;
      if (this.context) void this.context.close().catch(() => {});
      this.context = undefined;
      this.helmet = undefined;
    }
  }

  pause() {
    this.active = false;
    if (this.context && this.context.state !== 'closed') void this.context.suspend().catch(() => {});
  }

  update(speed: number, dt: number) {
    const c = this.context, h = this.helmet;
    if (!this.active || !c || !h || c.state !== 'running') return;
    // Only sustained travel above walking pace builds a recovery breath.
    const running = Math.min(1, Math.max(0, (speed - walkSpeed) / (sprintSpeed - walkSpeed)));
    const target = running * running * (3 - 2 * running);
    // Average the last stretch of running so duration still matters after breathing peaks.
    this.recentEffort += (target - this.recentEffort) * -Math.expm1(-dt / 35);
    const responseSeconds = target > this.exertion ? 3.2 : 2 + 23 * this.recentEffort;
    this.exertion += (target - this.exertion) * -Math.expm1(-dt / responseSeconds);
    const now = c.currentTime;
    if (now < this.nextBreath - .06) return;
    const start = Math.max(now + .01, this.nextBreath);
    const cycle = 60 / (13 + 20 * this.exertion) * (.955 + .09 * Math.random());
    const level = (.004 + .089 * this.exertion) * (.94 + .12 * Math.random());
    const inhaling = cycle * .37;
    h.intake.frequency.setTargetAtTime(770 + 200 * this.exertion + 60 * Math.random(), start, .13);
    h.exhaust.frequency.setTargetAtTime(460 + 150 * this.exertion + 60 * Math.random(), start, .13);
    airflow(h.inhale.gain, start, inhaling, level, false);
    airflow(h.exhale.gain, start + inhaling + .06, cycle * .48, level * .95, true);
    this.nextBreath = start + cycle;
  }

  step(onStone: boolean, impact: number) {
    const c = this.context, h = this.helmet;
    if (!this.active || !c || !h || c.state !== 'running') return;
    const now = c.currentTime;
    const strength = Math.min(1, Math.max(0, impact / 1.8));
    const variation = .94 + .12 * Math.random();
    const duration = (onStone ? .095 : .14) + .07 * strength;
    const body = c.createOscillator();
    body.frequency.setValueAtTime((onStone ? 108 : 87) * variation, now);
    body.frequency.exponentialRampToValueAtTime((onStone ? 54 : 44) * variation, now + duration);
    const envelope = gain(c, .0001, h.output);
    envelope.gain.setValueAtTime(.0001, now);
    envelope.gain.linearRampToValueAtTime(.065 + .20 * strength, now + (onStone ? .003 : .009));
    envelope.gain.exponentialRampToValueAtTime(.0001, now + duration);
    body.connect(envelope);
    body.onended = () => { body.disconnect(); envelope.disconnect(); };
    body.start(now);
    body.stop(now + duration + .01);

    const contact = c.createBufferSource();
    contact.buffer = h.noise;
    const tone = gain(c, .0001, h.output);
    const tap = filter(c, 'bandpass', (onStone ? 740 : 310) * variation, .76, tone);
    const decay = onStone ? .041 : .105;
    tone.gain.setValueAtTime(.0001, now);
    tone.gain.linearRampToValueAtTime((onStone ? .23 : .13) * (.55 + strength), now + .003);
    tone.gain.exponentialRampToValueAtTime(.0001, now + decay);
    contact.connect(tap);
    contact.onended = () => { contact.disconnect(); tap.disconnect(); tone.disconnect(); };
    contact.start(now, Math.random() * (h.noise.duration - .2), decay + .01);
  }

  dispose() {
    this.disposed = true;
    this.active = false;
    if (this.context) void this.context.close().catch(() => {});
    this.context = undefined;
    this.helmet = undefined;
  }
}
