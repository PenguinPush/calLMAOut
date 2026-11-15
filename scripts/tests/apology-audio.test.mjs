import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

const temporary = await mkdtemp(join(tmpdir(), 'callmaout-apology-audio-'));
const rate = 48000;
const n = rate * 5;
try {
  for (const name of ['autotune', 'ukulele-audio']) {
    const source = await readFile(new URL(`../../src/lib/${name}.ts`, import.meta.url), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
      .replace('"./autotune"', '"./autotune.mjs"');
    await writeFile(join(temporary, `${name}.mjs`), code);
  }
  const { analyzeUkulele, tuneToUkulele, mixUkuleleApology } = await import(pathToFileURL(join(temporary, 'ukulele-audio.mjs')));
  const rms = (data) => Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
  const power = (data, hz) => {
    const coefficient = 2 * Math.cos(2 * Math.PI * hz / rate);
    let a = 0, b = 0;
    for (let i = 0; i < data.length; i++) {
      const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (data.length - 1));
      const next = data[i] * w + coefficient * a - b;
      b = a; a = next;
    }
    return a * a + b * b - coefficient * a * b;
  };
  const voice = Float32Array.from({ length: n }, (_, i) => 0.2 * Math.sin(2 * Math.PI * 190 * i / rate) + 0.07 * Math.sin(2 * Math.PI * 380 * i / rate));
  const music = Float32Array.from({ length: n }, (_, i) => 0.15 * Math.sin(2 * Math.PI * (i < n / 2 ? 220 : 329.627557) * i / rate));
  const notes = analyzeUkulele(music, rate);
  assert.ok(Math.abs(notes.hz[10] - 440) < 0.01, 'A backing maps to A pitch class');
  assert.ok(Math.abs(notes.hz[45] - 329.627557) < 0.01, 'E backing maps to E pitch class');
  const tuned = tuneToUkulele(voice, rate, notes);
  for (const [seconds, expected] of [[1, 220], [3.5, 164.813779]]) {
    const window = tuned.subarray(seconds * rate, (seconds + 0.2) * rate);
    assert.ok(power(window, expected) > power(window, 190) * 10, 'corrected pitch dominates original pitch by >10x energy');
  }
  const decoy = rate / 30;
  const mixed = mixUkuleleApology(voice, rate, music, notes, decoy);
  assert.equal(mixed.length, n);
  assert.deepEqual(mixed.subarray(0, decoy), voice.subarray(0, decoy));
  assert.ok(mixed.every((sample) => Number.isFinite(sample) && Math.abs(sample) <= 1));
  assert.equal(Math.abs(mixed.at(-1)), 0, 'ending fades to silence without a click');
  const delayed = mixUkuleleApology(new Float32Array(n), rate, music, notes, rate * 2);
  assert.ok(delayed.subarray(0, rate * 2).every((sample) => sample === 0), 'no backing before hands appear');
  assert.ok(rms(delayed.subarray(rate * 2, rate * 3)) > 0.05, 'backing starts when hands appear');
  const immediate = mixUkuleleApology(new Float32Array(rate * 3), rate, music, notes);
  assert.deepEqual(delayed.subarray(rate * 2), immediate, 'delayed MP3 starts at its beginning');
  assert.deepEqual(mixUkuleleApology(voice, rate, music, notes, n), voice, 'no hands keeps original voice and no music');
  const musicOnly = mixUkuleleApology(new Float32Array(n), rate, music, notes);
  assert.ok(rms(musicOnly) > 0.05, 'backing remains audible during speech pauses');
  const silent = mixUkuleleApology(new Float32Array(n), rate, new Float32Array(0), { hz: new Float32Array(0), hopSeconds: 0.08 });
  assert.ok(silent.every((sample) => sample === 0));
  const loud = mixUkuleleApology(voice.map((x) => x * 8), rate, music.map((x) => x * 8), notes);
  assert.ok(loud.every((sample) => Number.isFinite(sample) && Math.abs(sample) <= 0.970001));

  // Exercise the actual bundled MP3, decoded independently of browser Web Audio.
  const decode = (file) => {
    const result = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-t', '5', '-ac', '1', '-ar', String(rate), '-f', 'f32le', 'pipe:1'], { maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr?.toString() || result.error?.message);
    const bytes = Uint8Array.from(result.stdout);
    return new Float32Array(bytes.buffer);
  };
  const backing = decode('public/ukelele.mp3');
  assert.equal(backing.length, n);
  const started = performance.now();
  const realNotes = analyzeUkulele(backing, rate);
  const precomputeMs = performance.now() - started;
  assert.ok(realNotes.hz.some((hz) => hz > 0), 'bundled MP3 supplies pitch targets');
  const start = performance.now();
  const realMix = mixUkuleleApology(voice, rate, backing, realNotes, decoy);
  assert.equal(realMix.length, n);
  assert.ok(realMix.every((sample) => Number.isFinite(sample) && Math.abs(sample) <= 1));
  console.log(`Bundled backing analysis ${precomputeMs.toFixed(0)}ms (cached); 5s voice correction + mix ${(performance.now() - start).toFixed(0)}ms.`);
  if (process.env.APOLOGY_AUDIO_ARTIFACT_DIR) {
    const speech = decode('data/voicetest/speech2.wav');
    const padded = new Float32Array(n);
    padded.set(speech.subarray(0, n));
    const output = mixUkuleleApology(padded, rate, backing, realNotes, decoy);
    const directory = process.env.APOLOGY_AUDIO_ARTIFACT_DIR;
    await mkdir(directory, { recursive: true });
    const pcm = Buffer.from(output.buffer);
    const converted = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'f32le', '-ar', String(rate), '-ac', '1', '-i', 'pipe:0', join(directory, 'ukulele-apology.wav')], { input: pcm });
    assert.equal(converted.status, 0, converted.stderr?.toString());
  }
  console.log('Pitch targets, hard correction, background mixing, 5s duration, decoy, silence, and clipping checks passed.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
