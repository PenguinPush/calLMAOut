// Hard autotune onto a target melody. Whole recording at once:
// 1. track pitch with YIN (anti-aliased, 16 kHz, 10 ms hop), median-smoothed, short dropouts bridged;
// 2. place pitch marks on the actual glottal pulses of each voiced stretch;
// 3. TD-PSOLA: rebuild voiced stretches one grain per *target* period, with no glide. Unvoiced
//    audio passes through untouched.

const DETECT_RATE = 16000;
const HOP_MS = 10;
const WINDOW_MS = 40;
const MIN_HZ = 70;
const MAX_HZ = 500;
const YIN_THRESHOLD = 0.2;
const SILENCE = 0.1; // of the loud-frame level
// Voiced gaps this short are pitch-tracking dropouts, not real pauses.
const MAX_GAP_FRAMES = 4;

/** Picks the pitch (Hz) a voiced moment should be moved to, given the time and the sung pitch. */
export type PitchTarget = (seconds: number, sungHz: number) => number;

/** Snaps to the nearest equal-temperament note. */
export function nearestNoteHz(hz: number) {
  return 440 * 2 ** (Math.round(12 * Math.log2(hz / 440)) / 12);
}

/** The given note, moved by whole octaves to sit as close as possible to the sung pitch. */
export function nearestOctave(noteHz: number, sungHz: number) {
  return noteHz * 2 ** Math.round(Math.log2(sungHz / noteHz));
}

// Windowed-sinc low-pass, then keep every `factor`th sample.
function downsample(x: Float32Array, factor: number) {
  if (factor === 1) return x;
  const taps = 8 * factor + 1;
  const half = (taps - 1) / 2;
  const kernel = new Float32Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const t = i - half;
    const sinc = t ? Math.sin((Math.PI * t) / factor) / ((Math.PI * t) / factor) : 1;
    kernel[i] = sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1)));
    sum += kernel[i];
  }
  const y = new Float32Array(Math.floor(x.length / factor));
  for (let n = 0; n < y.length; n++) {
    let acc = 0;
    for (let i = 0; i < taps; i++) {
      const j = n * factor + i - half;
      if (j >= 0 && j < x.length) acc += x[j] * kernel[i];
    }
    y[n] = acc / sum;
  }
  return y;
}

// One sung pitch per hop (0 = unvoiced), in Hz.
function trackPitch(x: Float32Array, rate: number) {
  const factor = Math.max(1, Math.round(rate / DETECT_RATE));
  const y = downsample(x, factor);
  const r = rate / factor;
  const hop = Math.round((r * HOP_MS) / 1000);
  const window = Math.round((r * WINDOW_MS) / 1000);
  const tauMin = Math.floor(r / MAX_HZ);
  const tauMax = Math.ceil(r / MIN_HZ);
  const width = window - tauMax;
  const frames = Math.max(0, Math.floor((y.length - window) / hop) + 1);
  const levels = new Float32Array(frames);
  const pitch = new Float32Array(frames);
  const d = new Float32Array(tauMax + 2);

  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = 0; i < window; i++) e += y[f * hop + i] ** 2;
    levels[f] = Math.sqrt(e / window);
  }
  // Loud frames set the bar for what counts as silence, so mic gain doesn't matter.
  const loud = [...levels].sort((a, b) => a - b)[Math.floor(frames * 0.9)] ?? 0;

  for (let f = 0; f < frames; f++) {
    if (levels[f] < loud * SILENCE) continue;
    const o = f * hop;
    let running = 0;
    d[0] = 1;
    for (let tau = 1; tau <= tauMax; tau++) {
      let s = 0;
      for (let j = 0; j < width; j++) {
        const delta = y[o + j] - y[o + j + tau];
        s += delta * delta;
      }
      running += s;
      d[tau] = running ? (s * tau) / running : 1;
    }
    let tau = tauMin;
    while (tau < tauMax && d[tau] >= YIN_THRESHOLD) tau++;
    if (tau >= tauMax) continue;
    while (tau + 1 < tauMax && d[tau + 1] < d[tau]) tau++;
    const [a, b, c] = [d[tau - 1], d[tau], d[tau + 1]];
    const shift = a + c - 2 * b ? (a - c) / (2 * (a + c - 2 * b)) : 0;
    pitch[f] = r / (tau + Math.max(-1, Math.min(1, shift)));
  }

  // Median of 5 over voiced neighbours removes isolated octave errors.
  const smoothed = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    if (!pitch[f]) continue;
    const near = [];
    for (let k = f - 2; k <= f + 2; k++) if (pitch[k]) near.push(pitch[k]);
    near.sort((p, q) => p - q);
    smoothed[f] = near[Math.floor(near.length / 2)];
  }
  // Bridge short dropouts inside a voiced stretch.
  for (let f = 1; f < frames; f++) {
    if (smoothed[f] || !smoothed[f - 1]) continue;
    let g = f;
    while (g < frames && !smoothed[g]) g++;
    if (g < frames && g - f <= MAX_GAP_FRAMES) {
      for (let k = f; k < g; k++) smoothed[k] = smoothed[f - 1] + ((smoothed[g] - smoothed[f - 1]) * (k - f + 1)) / (g - f + 1);
    }
  }
  // Frames are centred half a window in, at full-rate sample positions.
  return { pitch: smoothed, hop: hop * factor, offset: (window * factor) / 2 };
}

type Mark = { pos: number; period: number; target: number };

// Pitch marks on the waveform's peaks in voiced stretches; evenly spaced elsewhere.
function placeMarks(x: Float32Array, rate: number, targetHz: PitchTarget) {
  const { pitch, hop, offset } = trackPitch(x, rate);
  const frameAt = (n: number) => Math.max(0, Math.min(pitch.length - 1, Math.round((n - offset) / hop)));
  const periodAt = (n: number) => (pitch[frameAt(n)] ? rate / pitch[frameAt(n)] : 0);
  const unvoiced = Math.round((rate * HOP_MS) / 1000);
  const marks: Mark[] = [];
  let n = 0;
  while (n < x.length) {
    if (!periodAt(n)) {
      marks.push({ pos: n, period: unvoiced, target: unvoiced });
      n += unvoiced;
      continue;
    }
    // A voiced stretch: pick its polarity, then walk peak to peak.
    let end = n;
    while (end < x.length && periodAt(end)) end += hop;
    end = Math.min(end, x.length);
    let [max, min] = [0, 0];
    for (let i = n; i < end; i++) [max, min] = [Math.max(max, x[i]), Math.min(min, x[i])];
    const sign = max >= -min ? 1 : -1;
    const peak = (from: number, to: number) => {
      let best = Math.max(0, from);
      for (let i = Math.max(0, from); i < Math.min(x.length, to); i++) if (x[i] * sign > x[best] * sign) best = i;
      return best;
    };
    let m = peak(n, n + periodAt(n));
    while (m < end) {
      const period = periodAt(m) || marks[marks.length - 1]?.period || unvoiced;
      marks.push({ pos: m, period, target: rate / targetHz(m / rate, rate / period) });
      const guess = m + period;
      m = peak(Math.round(guess - period * 0.2), Math.round(guess + period * 0.2) + 1);
      if (m <= marks[marks.length - 1].pos) m = Math.round(guess);
    }
    n = Math.max(end, marks[marks.length - 1].pos + 1);
  }
  return marks;
}

/** Moves every voiced moment of `input` to the pitch `targetHz` picks for it. */
export function autotuneBuffer(input: Float32Array, rate: number, targetHz: PitchTarget) {
  const marks = placeMarks(input, rate, targetHz);
  const acc = new Float32Array(input.length);
  const weight = new Float32Array(input.length);
  let k = 0;
  // Fractional positions, so rounding doesn't detune the notes.
  for (let at = marks[0]?.pos ?? input.length; at < input.length; ) {
    while (k + 1 < marks.length && Math.abs(marks[k + 1].pos - at) <= Math.abs(marks[k].pos - at)) k++;
    const mark = marks[k];
    const half = Math.round(mark.period);
    const centre = Math.round(at);
    for (let i = -half; i < half; i++) {
      const [src, dst] = [mark.pos + i, centre + i];
      if (src < 0 || src >= input.length || dst < 0 || dst >= input.length) continue;
      const w = 0.5 - 0.5 * Math.cos((Math.PI * (i + half)) / half);
      acc[dst] += input[src] * w;
      weight[dst] += w;
    }
    at += Math.max(1, mark.target);
  }
  return input.map((x, n) => (weight[n] > 0.05 ? acc[n] / weight[n] : x));
}
