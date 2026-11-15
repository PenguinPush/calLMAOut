import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import ts from 'typescript';

// Transpile the real implementation into a temporary ESM directory for Node.
const temporary = await mkdtemp(join(tmpdir(), 'callmaout-vocoder-test-'));
try {
  for (const name of ['vocoder', 'apology-melody', 'autotune']) {
    const source = await readFile(new URL(`../../src/lib/${name}.ts`, import.meta.url), 'utf8');
    const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
      .replace('"./apology-melody"', '"./apology-melody.mjs"')
      .replace('"./autotune"', '"./autotune.mjs"');
    await writeFile(join(temporary, `${name}.mjs`), js);
  }
  const { vocodeBuffer } = await import(pathToFileURL(join(temporary, 'vocoder.mjs')).href);
  const { noteAt } = await import(pathToFileURL(join(temporary, 'apology-melody.mjs')).href);

  const rate = 48000;
  const seconds = 5;
  const decoy = Math.round(rate / 30); // one video frame

  // Speech-like: glottal pulses through vowel formants, wandering intonation, and pauses,
  // over a constant background hiss the voice isolation should remove.
  const voice = new Float32Array(rate * seconds);
  const formants = [[700, 80], [1220, 90], [2600, 120]];
  const silentAt = (t) => t % 1.3 > 1.0;
  let cycle = 0;
  for (let n = 0; n < voice.length; n++) {
    const t = n / rate;
    cycle += (130 + 25 * Math.sin(2 * Math.PI * 0.7 * t)) / rate;
    if (cycle < 1) continue;
    cycle -= 1;
    if (silentAt(t)) continue;
    for (let i = 0; i < rate / 60 && n + i < voice.length; i++) {
      let s = 0;
      for (const [f, bw] of formants) s += Math.exp((-Math.PI * bw * i) / rate) * Math.sin((2 * Math.PI * f * i) / rate);
      voice[n + i] += 0.08 * s;
    }
  }
  const clean = voice.slice();
  for (let n = 0; n < voice.length; n++) voice[n] += (Math.random() * 2 - 1) * 0.004;

  const started = performance.now();
  const output = vocodeBuffer(voice, rate, decoy);
  const elapsed = performance.now() - started;
  assert.equal(output.length, voice.length, 'output lines up with the input');
  for (let n = 0; n < decoy; n++) assert.equal(output[n], voice[n], `decoy sample ${n} was changed`);

  // Energy at one frequency (Goertzel), Hann-windowed.
  const power = (x, hz) => {
    const k = 2 * Math.cos((2 * Math.PI * hz) / rate);
    let [s1, s2] = [0, 0];
    for (let i = 0; i < x.length; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (x.length - 1));
      [s2, s1] = [s1, x[i] * w + k * s1 - s2];
    }
    return s1 * s1 + s2 * s2 - k * s1 * s2;
  };
  const rms = (x) => Math.sqrt(x.reduce((sum, v) => sum + v * v, 0) / x.length);
  // Spectral envelope from LPC (order 18): the shape of the vocal tract, independent of pitch,
  // so it shows whether autotuning kept the voice sounding like the same person.
  const envelope = (x) => {
    const order = 18, n = x.length, w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = x[i] * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1)));
    const r = new Float64Array(order + 1);
    for (let k = 0; k <= order; k++) for (let i = k; i < n; i++) r[k] += w[i] * w[i - k];
    r[0] *= 1 + 1e-9;
    let a = new Float64Array(order + 1);
    a[0] = 1;
    let err = r[0];
    for (let i = 1; i <= order; i++) {
      let acc = r[i];
      for (let j = 1; j < i; j++) acc -= a[j] * r[i - j];
      const k = acc / err;
      const next = a.slice();
      next[i] = k;
      for (let j = 1; j < i; j++) next[j] = a[j] - k * a[i - j];
      a = next;
      err *= 1 - k * k;
    }
    const out = [];
    for (let f = 300; f <= 4000; f *= 2 ** (1 / 12)) {
      let [re, im] = [1, 0];
      for (let j = 1; j <= order; j++) { re -= a[j] * Math.cos((2 * Math.PI * f * j) / rate); im += a[j] * Math.sin((2 * Math.PI * f * j) / rate); }
      out.push(-Math.log(re * re + im * im));
    }
    const mean = out.reduce((p, v) => p + v, 0) / out.length;
    return out.map((v) => v - mean);
  };
  const correlation = (a, b) => {
    let [ab, aa, bb] = [0, 0, 0];
    for (let i = 0; i < a.length; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
    return ab / Math.sqrt(aa * bb || 1);
  };
  // Dominant pitch (normalized autocorrelation, 60–1000 Hz).
  const pitch = (x) => {
    let best = 0, bestLag = 0;
    for (let lag = Math.floor(rate / 1000); lag < Math.floor(rate / 60); lag++) {
      let num = 0, a = 0, b = 0;
      for (let i = 0; i + lag < x.length; i++) { num += x[i] * x[i + lag]; a += x[i] * x[i]; b += x[i + lag] * x[i + lag]; }
      const score = num / Math.sqrt(a * b || 1);
      if (score > best) { best = score; bestLag = lag; }
    }
    return rate / bestLag;
  };
  const average = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

  const chunk = Math.round(rate * 0.08);
  let melodyHeard = 0, melodyChecked = 0, sungOnMelody = 0;
  const likeVoice = [], loud = [], quiet = [], inputQuiet = [];
  for (let start = decoy + chunk; start + chunk <= voice.length; start += chunk) {
    const [from, to] = [start / rate, (start + chunk) / rate];
    const part = output.subarray(start, start + chunk);
    // Inside a pause, past the gate's ~100ms fade-out after the last word.
    if (silentAt(from - 0.1) && silentAt(from) && silentAt(to)) { quiet.push(rms(part)); inputQuiet.push(rms(voice.subarray(start, start + chunk))); continue; }
    if (silentAt(from) && silentAt(to)) continue;
    if (silentAt(from) || silentAt(to)) continue;
    loud.push(rms(part));
    // Your voice: autotuning moves the pitch but keeps the formants, so the envelope matches.
    likeVoice.push(correlation(envelope(part), envelope(clean.subarray(start, start + chunk))));
    // The melody: its note (or the sub-octave under it) stands out against pitches a tone away.
    const note = noteAt(from);
    if (note === null || noteAt(to) !== note) continue;
    melodyChecked++;
    const hz = 440 * 2 ** ((note - 69) / 12);
    const on = Math.max(power(part, hz), power(part, hz / 2));
    const off = Math.max(...[-2, 2].flatMap((t) => [power(part, hz * 2 ** (t / 12)), power(part, (hz / 2) * 2 ** (t / 12))]));
    if (on > off * 2) melodyHeard++;
    // The voice is autotuned onto the same melody, so the dominant pitch is the melody's note (any octave).
    const semitones = 12 * Math.log2(pitch(part) / hz);
    if (Math.abs(semitones - 12 * Math.round(semitones / 12)) <= 0.4) sungOnMelody++;
  }
  console.log(
    `melody audible in ${melodyHeard}/${melodyChecked} voiced 80ms chunks; dominant pitch on the melody's note in ${sungOnMelody}/${melodyChecked}; voice envelope match ${median(likeVoice).toFixed(2)}; ` +
      `background noise in pauses ${(average(quiet) / average(inputQuiet) * 100).toFixed(0)}% of the input's; ${seconds}s in ${elapsed.toFixed(0)}ms`,
  );
  assert.ok(melodyHeard / melodyChecked >= 0.8, 'the melody should be clearly audible');
  assert.ok(sungOnMelody / melodyChecked >= 0.7, 'the voice should be autotuned onto the melody');
  assert.ok(median(likeVoice) >= 0.8, 'the original voice (its formants) should still come through');
  assert.ok(average(quiet) < average(inputQuiet) * 0.3, 'background noise between words should be gated out');
  assert.ok(average(quiet) < average(loud) * 0.15, 'pauses in the voice should stay quiet');
  assert.ok(elapsed < seconds * 1000 / 4, 'vocoding must run well faster than real time');
  console.log('vocoder: ok');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
