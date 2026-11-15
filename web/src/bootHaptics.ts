export function bootPulse(pad: Gamepad | undefined, onStone: boolean, impact: number) {
  if (!pad) return;
  const load = Math.max(0,Math.min(1,impact / 1.8));
  const strength = (onStone ? .22 : .12) + .40*load;
  const duration = (onStone ? 32 : 50) + 45*load;
  try {
    const motor = pad.hapticActuators?.[0];
    if (motor?.pulse) void motor.pulse(strength,duration).catch(()=>{});
    else if (pad.vibrationActuator?.playEffect) {
      void pad.vibrationActuator.playEffect('dual-rumble',{ duration, strongMagnitude:strength,
        weakMagnitude: onStone ? strength : strength*.35 }).catch(()=>{});
    }
  } catch { /* Actuators can disconnect between contact and pulse. */ }
}
