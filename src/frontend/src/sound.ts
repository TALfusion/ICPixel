// Synthesized SFX via Web Audio. No asset files — every sound is generated
// from oscillators so the bundle stays tiny and we don't fight asset loading.
//
// Events (per spec):
//   pop      — pixel placed
//   error    — placement rejected (cooldown, etc.)
//   ding     — your pixel landed correctly inside your mission template
//   fanfare  — mission just crossed the ≥95% completion threshold
//   whoosh   — map grew to a new stage
//   chord    — alliance just got created

let ctx: AudioContext | null = null;
let muted = false;

function ac(): AudioContext | null {
  if (muted) return null;
  if (ctx) return ctx;
  try {
    const Ctor =
      (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
        .AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    return ctx;
  } catch {
    return null;
  }
}

export function setMuted(m: boolean) {
  muted = m;
}
export function isMuted(): boolean {
  return muted;
}

/// Resume the audio context after a user gesture. Browsers block AudioContext
/// until the user interacts with the page; call this from any click handler.
export function unlockAudio() {
  const c = ac();
  if (c && c.state === "suspended") c.resume().catch(() => {});
}

// ── Primitives ────────────────────────────────────────────────────────
function tone(opts: {
  freq: number;
  endFreq?: number;
  type?: OscillatorType;
  attack?: number;
  decay?: number;
  duration: number;
  gain?: number;
  delay?: number;
}) {
  const c = ac();
  if (!c) return;
  const t0 = c.currentTime + (opts.delay ?? 0);
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = opts.type ?? "square";
  osc.frequency.setValueAtTime(opts.freq, t0);
  if (opts.endFreq != null) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.endFreq), t0 + opts.duration);
  }
  const peak = opts.gain ?? 0.18;
  const attack = opts.attack ?? 0.005;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.duration);
  osc.connect(g).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + opts.duration + 0.02);
}

function noise(opts: { duration: number; gain?: number; delay?: number; lowpass?: number }) {
  const c = ac();
  if (!c) return;
  const t0 = c.currentTime + (opts.delay ?? 0);
  const len = Math.floor(c.sampleRate * opts.duration);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  const g = c.createGain();
  const peak = opts.gain ?? 0.15;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.duration);
  if (opts.lowpass) {
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = opts.lowpass;
    src.connect(lp).connect(g).connect(c.destination);
  } else {
    src.connect(g).connect(c.destination);
  }
  src.start(t0);
  src.stop(t0 + opts.duration + 0.02);
}

// ── Public events ─────────────────────────────────────────────────────
export function playPlacePixel() {
  // Short blip — pitched square sweeping up.
  tone({ freq: 520, endFreq: 880, type: "square", duration: 0.07, gain: 0.12 });
}

export function playError() {
  // Soft buzz — low sawtooth, slight downward sweep.
  tone({ freq: 180, endFreq: 110, type: "sawtooth", duration: 0.22, gain: 0.1 });
}

export function playMissionDing() {
  // Bright bell-ish two-tone.
  tone({ freq: 988, type: "triangle", duration: 0.18, gain: 0.14 });
  tone({ freq: 1318, type: "triangle", duration: 0.22, gain: 0.1, delay: 0.05 });
}

export function playMissionComplete() {
  // Fanfare: ascending major arpeggio + sparkle.
  const notes = [523, 659, 784, 1046]; // C5 E5 G5 C6
  notes.forEach((f, i) => {
    tone({ freq: f, type: "square", duration: 0.18, gain: 0.13, delay: i * 0.09 });
    tone({ freq: f * 2, type: "triangle", duration: 0.18, gain: 0.06, delay: i * 0.09 });
  });
  tone({ freq: 1568, type: "triangle", duration: 0.4, gain: 0.1, delay: 0.45 });
}

export function playMapGrew() {
  // Whoosh — filtered noise sweep + low rumble.
  noise({ duration: 0.45, gain: 0.18, lowpass: 1800 });
  tone({ freq: 90, endFreq: 220, type: "sine", duration: 0.45, gain: 0.18 });
}

export function playAllianceCreated() {
  // Triumphal triad: C major chord with shimmer.
  tone({ freq: 523, type: "triangle", duration: 0.55, gain: 0.12 });
  tone({ freq: 659, type: "triangle", duration: 0.55, gain: 0.12, delay: 0.04 });
  tone({ freq: 784, type: "triangle", duration: 0.6, gain: 0.12, delay: 0.08 });
  tone({ freq: 1046, type: "sine", duration: 0.5, gain: 0.08, delay: 0.2 });
}
