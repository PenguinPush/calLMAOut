import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

// Transpile the real implementation into a temporary ESM directory for Node.
const temporary = await mkdtemp(join(tmpdir(), 'callmaout-gif-test-'));
try {
  await writeFile(join(temporary, "gifenc.mjs"), await readFile("node_modules/gifenc/dist/gifenc.esm.js"));
  for (const name of ['prepared-cache', 'gif-transitions', 'gif-encoder']) {
    const source = await readFile(new URL(`../../src/lib/${name}.ts`, import.meta.url), 'utf8');
    const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
      .replace('"./gif-transitions"', '"./gif-transitions.mjs"')
      .replace('"gifenc"', '"./gifenc.mjs"');
    await writeFile(join(temporary, `${name}.mjs`), js);
  }
  const { PreparedCache } = await import(pathToFileURL(join(temporary, 'prepared-cache.mjs')));
  const cache = new PreparedCache();
  const neutral = { at: 100, smiling: false, dataUrl: 'neutral' };
  const smile = { at: 500, smiling: true, dataUrl: 'smile' };
  assert.equal(cache.ready(0, true), null);
  cache.publish(neutral, cache.generation);
  cache.publish(smile, cache.generation);
  assert.equal(cache.ready(600, true).photo, smile);
  cache.publish({ at: 700, smiling: false, dataUrl: 'new-neutral' }, cache.generation);
  assert.equal(cache.ready(800, true).photo, smile);
  assert.equal(cache.ready(800, false).photo.dataUrl, 'new-neutral');
  cache.typed(3000);
  assert.equal(cache.ready(4000, true).photo, smile);
  const inFlight = cache.generation;
  cache.forget();
  assert.equal(cache.publish({ at: 4000, smiling: true }, inFlight), false);
  assert.equal(cache.ready(4001, true), null);
  cache.publish({ at: 4100, smiling: false }, cache.generation);
  assert.equal(cache.ready(4200, true).remembered, false);
  cache.clear();
  assert.equal(cache.ready(4200, false), null);
  cache.publish({ at: 5000, smiling: true }, cache.generation);
  cache.typed(8001);
  assert.equal(cache.ready(8001, true), null, 'typing cannot revive an expired smile');
  cache.clear();
  cache.publish({ at: 0, smiling: true }, cache.generation);
  cache.publish({ at: 2900, smiling: false }, cache.generation);
  assert.equal(cache.ready(3001, true).photo.at, 2900, 'expiry switches to the prepared neutral GIF');
  const { transitionMaps, TRANSITIONS, TRANSITION_SPECS, EFFECT_COLORS, chooseTransitions, animationDuration } = await import(pathToFileURL(join(temporary, 'gif-transitions.mjs')));
  const { encodeTransition } = await import(pathToFileURL(join(temporary, 'gif-encoder.mjs')));
  const width = 480, height = 270;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    pixels.set([x % 256, y % 256, (x * 7 + y * 11) % 256, 255], i);
  }
  const chosenPairs = new Set();
  for (let a = 0; a < 4; a++) for (let b = 0; b < 3; b++) {
    const values = [(a + 0.5) / 4, (b + 0.5) / 3];
    const pair = chooseTransitions(() => values.shift());
    assert.notEqual(pair.entrance, pair.effect);
    chosenPairs.add(`${pair.entrance}-${pair.effect}`);
  }
  assert.equal(chosenPairs.size, 12);
  const manifest = [];
  for (const effect of TRANSITIONS) {
    const maps = transitionMaps(width, height, effect);
    assert.equal(maps.length, TRANSITION_SPECS[effect].frames);
    for (const map of maps) for (const index of map) assert.ok(index >= -EFFECT_COLORS.length && index < width * height);
    assert.ok(maps.at(-1).every((index) => index === -1));
    for (const [w, h] of [[160, 120], [120, 160]]) {
      for (const map of transitionMaps(w, h, effect)) {
        assert.equal(map.length, w * h);
        for (const index of map) assert.ok(index >= -EFFECT_COLORS.length && index < w * h);
      }
    }
    assert.throws(() => encodeTransition(pixels, width, height, effect, effect), /must differ/);
    for (const entrance of TRANSITIONS.filter((value) => value !== effect)) {
      const start = performance.now();
      const bytes = encodeTransition(pixels, width, height, effect, entrance);
      const elapsed = performance.now() - start;
      assert.equal(Buffer.from(bytes.subarray(0, 6)).toString(), 'GIF89a');
      assert.equal(bytes.at(-1), 0x3b);
      const name = `${entrance}-to-${effect}`;
      await writeFile(join(temporary, `${name}.gif`), bytes);
      if (process.env.GIF_TEST_ARTIFACT_DIR) {
        await mkdir(process.env.GIF_TEST_ARTIFACT_DIR, { recursive: true });
        await copyFile(join(temporary, `${name}.gif`), join(process.env.GIF_TEST_ARTIFACT_DIR, `${name}.gif`));
      }
      manifest.push({ name, holdFrame: TRANSITION_SPECS[entrance].frames,
        count: TRANSITION_SPECS[entrance].frames + 1 + TRANSITION_SPECS[effect].frames,
        duration: animationDuration(entrance, effect) });
      console.log(`${entrance} → ${effect}: ${elapsed.toFixed(1)}ms, ${(bytes.length / 1024).toFixed(0)}KB (synthetic 480×270 image, Node)`);
    }
  }
  await writeFile(join(temporary, 'manifest.json'), JSON.stringify(manifest));
  // Decode with an independent implementation: full frame count, timing, loop,
  // distinct entrance/exit pairs, transparent start/end, and a 2-second photo hold.
  const decoded = spawnSync('python3', ['-c', `
from PIL import Image, ImageChops
from pathlib import Path
import sys, json
root = Path(sys.argv[1])
for case in json.loads((root / 'manifest.json').read_text()):
    im = Image.open(root / (case['name'] + '.gif'))
    assert im.size == (480, 270)
    assert im.n_frames == case['count'], (case['name'], im.n_frames)
    assert im.info['loop'] == 0
    assert im.info['transparency'] == 0
    assert im.convert('RGBA').getchannel('A').getbbox() is None
    im.seek(case['holdFrame'])
    assert im.info['duration'] == 2000
    assert im.convert('RGBA').getchannel('A').getextrema() == (255, 255)
    assert im.convert('RGBA').getpixel((0, 0))[3] == 255, 'black photo pixels must remain opaque'
    photo = im.convert('RGB').copy()
    im.seek(case['holdFrame'] + 4)
    assert im.convert('RGBA').getchannel('A').getextrema() == (0, 255)
    assert im.disposal_method == 2
    assert ImageChops.difference(photo, im.convert('RGB')).getbbox() is not None
    im.seek(im.n_frames - 1)
    assert im.convert('RGBA').getchannel('A').getbbox() is None
    assert im.info['duration'] == 250
    total = 0
    holds = 0
    for frame in range(im.n_frames):
        im.seek(frame)
        total += im.info['duration']
        holds += im.info['duration'] == 2000
    assert total == case['duration']
    assert holds == 1
print('Independent GIF decoding passed for all 12 distinct entrance/exit pairs.')
`, temporary], { encoding: 'utf8' });
  assert.equal(decoded.status, 0, decoded.stderr);
  console.log(decoded.stdout.trim());
  console.log('Cache priority, cold start, expiry, invalidation, and transition tests passed.');

  // Exercise the real offscreen orchestration with a controlled camera/encoder.
  const harness = { jobs: [], smiling: false, calls: [], stops: 0 };
  globalThis.gifHarness = harness;
  const mockModule = `
    const h = globalThis.gifHarness;
    export async function loadFace() {}
    export async function loadStickers() {}
    export async function warmGifWorker() {}
    export function stopGifWorker() {
      for (const job of h.jobs) if (!job.done) { job.done = true; job.reject(new Error('cancelled')); }
    }
    export async function analyzeFace() {
      h.calls.push('analyze');
      return { face: true, smile: h.smiling ? 0.9 : 0.1, boxes: [], crop: '', ms: 1 };
    }
    export async function drawPhotoStickers() { h.calls.push('decorate'); }
    // The apology recorder isn't exercised here.
    export class ApologySession {}
    export class ApologyPreview {}
    export class MicrophoneError extends Error {}
    export async function warmApologyModels() {}
    export function encodeGif() {
      h.calls.push('encode');
      return new Promise((resolve, reject) => h.jobs.push({ resolve, reject, done: false }));
    }
  `;
  await writeFile(join(temporary, 'mocks.mjs'), mockModule);
  const offscreenSource = await readFile(new URL('../../src/offscreen.ts', import.meta.url), 'utf8');
  const offscreenJs = ts.transpileModule(offscreenSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    .replaceAll('"./lib/face"', '"./mocks.mjs"')
    .replaceAll('"./lib/photo-overlays"', '"./mocks.mjs"')
    .replaceAll('"./lib/gif-client"', '"./mocks.mjs"')
    .replaceAll('"./lib/apology-recorder"', '"./mocks.mjs"')
    .replaceAll('"./lib/apology-preview"', '"./mocks.mjs"')
    .replaceAll('"./lib/prepared-cache"', '"./prepared-cache.mjs"');
  await writeFile(join(temporary, 'offscreen.mjs'), offscreenJs);
  const video = { videoWidth: 1280, videoHeight: 720, async play() {} };
  globalThis.document = {
    getElementById: () => video,
    createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }) }),
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: {
    async getUserMedia() {
      const stream = { active: true, getTracks: () => [{ stop() { stream.active = false; harness.stops++; } }] };
      return stream;
    },
  } } });
  let listener;
  globalThis.chrome = { runtime: { onMessage: { addListener(fn) { listener = fn; } }, onConnect: { addListener() {} } } };
  await import(pathToFileURL(join(temporary, 'offscreen.mjs')));
  const send = (message) => new Promise((resolve) => listener(message, {}, resolve));
  const tell = (message) => listener(message, {}, () => {});
  const until = async (condition) => {
    const deadline = performance.now() + 3000;
    while (!condition()) {
      if (performance.now() > deadline) throw new Error('Offscreen integration test timed out');
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
  };
  const complete = (index) => {
    const job = harness.jobs[index];
    assert.ok(job && !job.done);
    job.done = true;
    job.resolve({ dataUrl: 'data:image/gif;base64,frame' + index, effect: 'cube', entrance: 'shatter', durationMs: 3610, encodeMs: 20 });
  };
  const config = { deviceId: '', threshold: 0.5, rememberSmiles: true, smileMemoryMs: 3000 };
  try {
    tell({ type: 'offscreen-watch', config });
    await until(() => harness.jobs.length === 1);
    assert.deepEqual(harness.calls.slice(0, 3), ['analyze', 'decorate', 'encode']);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(harness.jobs.length, 1, 'no frame queue while encoding');
    let coldDone = false;
    const cold = send({ type: 'offscreen-capture', config }).then((result) => { coldDone = true; return result; });
    await Promise.resolve();
    assert.equal(coldDone, false);
    complete(0);
    assert.equal((await cold).mimeType, 'image/gif');
    await until(() => harness.jobs.length === 2);
    complete(1);
    await until(() => harness.jobs.length === 3);
    const count = harness.jobs.length;
    const hit = await send({ type: 'offscreen-capture', config });
    assert.equal(hit.dataUrl, 'data:image/gif;base64,frame1');
    assert.equal(harness.jobs.length, count, 'cache hit starts no detection or encoding');
    harness.smiling = true;
    complete(2); // Invalidated by the capture; cannot replace cache.
    await until(() => harness.jobs.length === 4);
    complete(3);
    await until(() => harness.jobs.length === 5);
    assert.equal((await send({ type: 'offscreen-remembered' })).remembered, true);
    tell({ type: 'offscreen-forget' });
    harness.smiling = false;
    complete(4); // In-flight smile must not reappear after Enter.
    await until(() => harness.jobs.length === 6);
    const afterForget = await send({ type: 'offscreen-remembered' });
    assert.ok(!afterForget || !afterForget.remembered);
    complete(5);
    await until(() => harness.jobs.length === 7);
    assert.equal((await send({ type: 'offscreen-remembered' })).remembered, false);
    const changed = { ...config, deviceId: 'other-camera' };
    tell({ type: 'offscreen-watch', config: changed });
    assert.equal(await send({ type: 'offscreen-remembered' }), null, 'camera change clears old GIFs');
    await until(() => harness.jobs.length === 8);
    complete(7);
    await until(() => harness.jobs.length === 9);
    assert.equal((await send({ type: 'offscreen-capture', config: changed })).dataUrl, 'data:image/gif;base64,frame7');
  } finally {
    tell({ type: 'offscreen-watch', config: null });
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(harness.stops > 0);
  console.log('Offscreen integration passed: backpressure, warm cache hits, cold wait, clean analysis order, forgetting, camera changes, and shutdown.');

} finally {
  await rm(temporary, { recursive: true, force: true });
}
