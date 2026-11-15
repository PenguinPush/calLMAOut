// Vocodes the apology onto MELODY. First the voice is isolated (speech band only, room noise
// gated out between words); then a 32-band channel vocoder takes the shape of each band from the
// voice (so the words survive) and the pitch from detuned saws playing the melody. Some overdrive,
// and the clean voice is mixed back in so it's still recognisably you, autotuned onto the same
// melody (in your own octave) so you sing along with it. Runs on the whole recording.
import { noteAt } from "./apology-melody";
import { autotuneBuffer, nearestNoteHz, nearestOctave } from "./autotune";

const BANDS = 32;
const LOW_HZ = 120;
const HIGH_HZ = 7000;
const ATTACK_MS = 2;
const RELEASE_MS = 20;
// Detuned saws (in cents) plus a sub-octave, for a thick, nasty carrier.
const VOICES = [-14, 0, 14];
const SUB_OCTAVE = 0.5;
// Noise in the carrier lets "s" and "t" sounds come through.
const NOISE = 0.15;
const DRIVE = 1.5;
// How much clean voice vs. vocoder ends up in the mix.
const DRY = 0.6;
const WET = 0.55;
// Voice isolation: keep the speech band, and gate anything near the room's noise floor.
const SPEECH_LOW_HZ = 85;
const SPEECH_HIGH_HZ = 8000;
const GATE_FRAME_MS = 10;
const GATE_OPEN = 4; // times the noise floor
const GATE_CLOSED = 2;
const CROSSFADE_MS = 10;

// RBJ biquads, each a reusable filter with its own state.
function biquad(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number) {
  let [x1, x2, y1, y2] = [0, 0, 0, 0];
  return (x: number) => {
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    [x2, x1, y2, y1] = [x1, x, y1, y];
    return y;
  };
}

function bandPass(rate: number, hz: number, q: number) {
  const w = (2 * Math.PI * hz) / rate;
  const alpha = Math.sin(w) / (2 * q);
  return biquad(alpha, 0, -alpha, 1 + alpha, -2 * Math.cos(w), 1 - alpha);
}

function highPass(rate: number, hz: number) {
  const w = (2 * Math.PI * hz) / rate;
  const [cos, alpha] = [Math.cos(w), Math.sin(w) / Math.SQRT2];
  return biquad((1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
}

function lowPass(rate: number, hz: number) {
  const w = (2 * Math.PI * hz) / rate;
  const [cos, alpha] = [Math.cos(w), Math.sin(w) / Math.SQRT2];
  return biquad((1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
}

// Keeps the speech band, then gates out whatever sits near the noise floor between words.
// The floor is measured from the recording itself (its quietest 10ms stretches).
function isolateVoice(input: Float32Array, rate: number) {
  const [hp, lp] = [highPass(rate, SPEECH_LOW_HZ), lowPass(rate, Math.min(SPEECH_HIGH_HZ, rate * 0.45))];
  const voice = input.map((x) => lp(hp(x)));
  const frame = Math.round((rate * GATE_FRAME_MS) / 1000);
  const levels: number[] = [];
  for (let start = 0; start < voice.length; start += frame) {
    let e = 0;
    const end = Math.min(voice.length, start + frame);
    for (let n = start; n < end; n++) e += voice[n] * voice[n];
    levels.push(Math.sqrt(e / (end - start)));
  }
  const floor = [...levels].sort((a, b) => a - b)[Math.floor(levels.length * 0.1)] || 1e-6;
  // Per-frame gate gain, smoothed so it opens fast and closes gently.
  let gain = 0;
  const gains = levels.map((level) => {
    const open = Math.max(0, Math.min(1, (level / floor - GATE_CLOSED) / (GATE_OPEN - GATE_CLOSED)));
    gain = open > gain ? open : gain * 0.5 + open * 0.5;
    return gain;
  });
  for (let n = 0; n < voice.length; n++) {
    const f = n / frame;
    const i = Math.min(gains.length - 1, Math.floor(f));
    const next = gains[Math.min(gains.length - 1, i + 1)];
    voice[n] *= gains[i] + (next - gains[i]) * (f - i);
  }
  return voice;
}

function peak(x: Float32Array) {
  let p = 0;
  for (const v of x) p = Math.max(p, Math.abs(v));
  return p;
}

/** Vocodes a whole recording onto MELODY. The first `decoySamples` stay untouched. */
export function vocodeBuffer(input: Float32Array, rate: number, decoySamples: number) {
  const voice = isolateVoice(input, rate);
  // The carrier: saws following the melody, silent during rests.
  const carrier = new Float32Array(input.length);
  const phases = new Float64Array(VOICES.length + 1);
  for (let n = 0; n < input.length; n++) {
    const note = noteAt(n / rate);
    let s = (Math.random() * 2 - 1) * NOISE;
    if (note !== null) {
      const hz = 440 * 2 ** ((note - 69) / 12);
      for (let v = 0; v <= VOICES.length; v++) {
        const f = v < VOICES.length ? hz * 2 ** (VOICES[v] / 1200) : hz * SUB_OCTAVE;
        phases[v] = (phases[v] + f / rate) % 1;
        s += (2 * phases[v] - 1) * (v < VOICES.length ? 1 / VOICES.length : 0.5);
      }
    }
    carrier[n] = s;
  }

  // Each band: the carrier's band, scaled by how loud the voice is in that same band.
  const wet = new Float32Array(input.length);
  const q = 1 / (2 * Math.sinh((Math.log(2) / 2) * (Math.log2(HIGH_HZ / LOW_HZ) / BANDS)));
  const attack = Math.exp(-1000 / (rate * ATTACK_MS));
  const release = Math.exp(-1000 / (rate * RELEASE_MS));
  for (let b = 0; b < BANDS; b++) {
    const hz = LOW_HZ * (HIGH_HZ / LOW_HZ) ** ((b + 0.5) / BANDS);
    const voiceBand = bandPass(rate, hz, q);
    const carrierBand = bandPass(rate, hz, q);
    let envelope = 0;
    for (let n = 0; n < input.length; n++) {
      const level = Math.abs(voiceBand(voice[n]));
      envelope = level + (level > envelope ? attack : release) * (envelope - level);
      wet[n] += carrierBand(carrier[n]) * envelope;
    }
  }

  // Your voice on the melody's notes (nearest semitone during its rests).
  const sung = autotuneBuffer(voice, rate, (seconds, sungHz) => {
    const note = noteAt(seconds);
    return note === null ? nearestNoteHz(sungHz) : nearestOctave(440 * 2 ** ((note - 69) / 12), sungHz);
  });

  // Some overdrive on the vocoder, the autotuned voice on top, then the original's peak level.
  const [wetPeak, voicePeak] = [peak(wet) || 1, peak(sung) || 1];
  const output = new Float32Array(input.length);
  for (let n = 0; n < input.length; n++) {
    const vocoded = Math.tanh((wet[n] / wetPeak) * DRIVE) / Math.tanh(DRIVE);
    output[n] = WET * vocoded + DRY * (sung[n] / voicePeak);
  }
  const gain = peak(input) / (peak(output) || 1);
  const crossfade = Math.round((rate * CROSSFADE_MS) / 1000);
  for (let n = 0; n < input.length; n++) {
    const fade = Math.max(0, Math.min(1, (n - decoySamples) / crossfade));
    output[n] = input[n] + (output[n] * gain - input[n]) * fade;
  }
  return output;
}
