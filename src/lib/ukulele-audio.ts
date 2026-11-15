import { autotuneBuffer, nearestNoteHz, nearestOctave } from "./autotune";

export type BackingNotes = { hz: Float32Array; hopSeconds: number };
const NOTE_HOP = 0.08;
const midiHz = (note: number) => 440 * 2 ** ((note - 69) / 12);

// The backing is polyphonic: follow its strongest pitch class rather than trying
// to run a single-voice pitch detector on a strummed chord. Analyze once per load.
export function analyzeUkulele(backing: Float32Array, rate: number): BackingNotes {
  const factor = Math.max(1, Math.floor(rate / 8000));
  const small = new Float32Array(Math.ceil(backing.length / factor));
  for (let i = 0; i < small.length; i++) {
    let sum = 0, count = 0;
    for (let j = i * factor; j < Math.min(backing.length, (i + 1) * factor); j++) { sum += backing[j]; count++; }
    small[i] = sum / Math.max(1, count);
  }
  const sampleRate = rate / factor;
  const windowSize = Math.round(sampleRate * 0.12);
  const window = Float32Array.from({ length: windowSize }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (windowSize - 1)));
  const hz = new Float32Array(Math.ceil(backing.length / rate / NOTE_HOP));
  const coeff = Float64Array.from({ length: 36 }, (_, i) => 2 * Math.cos(2 * Math.PI * midiHz(48 + i) / sampleRate));
  const classes = new Float64Array(12);
  for (let frame = 0; frame < hz.length; frame++) {
    classes.fill(0);
    const offset = Math.round((frame * NOTE_HOP + NOTE_HOP / 2) * sampleRate - windowSize / 2);
    for (let note = 0; note < coeff.length; note++) {
      let a = 0, b = 0;
      for (let i = 0; i < windowSize; i++) {
        const next = (small[offset + i] ?? 0) * window[i] + coeff[note] * a - b;
        b = a;
        a = next;
      }
      classes[note % 12] += Math.max(0, a * a + b * b - coeff[note] * a * b);
    }
    let best = 0;
    for (let i = 1; i < 12; i++) if (classes[i] > classes[best]) best = i;
    hz[frame] = classes[best] > 1e-7 ? midiHz(60 + best) : (hz[frame - 1] ?? 0);
  }
  // Remove isolated spectral flickers, without gliding between musical notes.
  const stable = hz.slice();
  for (let i = 1; i < hz.length - 1; i++) if (hz[i - 1] === hz[i + 1]) stable[i] = hz[i - 1];
  return { hz: stable, hopSeconds: NOTE_HOP };
}

function rms(input: Float32Array) {
  let sum = 0;
  for (const value of input) sum += value * value;
  return Math.sqrt(sum / Math.max(1, input.length));
}

export function tuneToUkulele(input: Float32Array, rate: number, notes: BackingNotes, startSample = 0) {
  return autotuneBuffer(input, rate, (seconds, sungHz) => {
    if (seconds * rate < startSample) return sungHz;
    const index = Math.max(0, Math.min(notes.hz.length - 1, Math.floor((seconds - startSample / rate) / notes.hopSeconds)));
    const target = notes.hz[index];
    return target ? nearestOctave(target, sungHz) : nearestNoteHz(sungHz);
  });
}

export function mixUkuleleApology(input: Float32Array, rate: number, backing: Float32Array, notes: BackingNotes, startSample = 0) {
  const start = Math.max(0, Math.min(input.length, Math.round(startSample)));
  if (start === input.length) return input.slice();
  // 100% corrected voice: no saw-wave carrier and no untuned layer underneath.
  const tuned = tuneToUkulele(input, rate, notes, start);
  const voiceGain = Math.min(8, 0.22 / Math.max(0.001, rms(tuned.subarray(start))));
  const musicGain = Math.min(4, 0.11 / Math.max(0.001, rms(backing)));
  const fade = Math.max(1, Math.round(rate * 0.008));
  const output = new Float32Array(input.length);
  let peak = 0;
  for (let i = start; i < input.length; i++) {
    const attack = Math.min(1, (i - start) / fade);
    const release = Math.min(1, (input.length - 1 - i) / fade);
    // Light saturation adds bite; vocals stay above the backing track.
    const voice = Math.tanh(tuned[i] * voiceGain * 1.4) / 1.4;
    const music = (backing[i - start] ?? 0) * musicGain;
    output[i] = (voice * attack + input[i] * (1 - attack) + music * attack) * release;
    peak = Math.max(peak, Math.abs(output[i]));
  }
  const limiter = peak > 0.97 ? 0.97 / peak : 1;
  for (let i = start; i < output.length; i++) output[i] *= limiter;
  output.set(input.subarray(0, start));
  return output;
}
