// Records the 5-second apology video in the offscreen page, then processes it.
// Recording does as little as possible per frame (draw + an off-thread JPEG encode), so the
// framerate stays smooth. Afterwards, one pass decodes each frame, tracks the hands, draws the
// ukulele and hands it to the hardware video encoder, while the voice is hard-autotuned over the ukulele backing track.
import { FilesetResolver, HandLandmarker, type NormalizedLandmark } from "@mediapipe/tasks-vision";
import {
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  CanvasSource,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
} from "mediabunny";
import { APOLOGY_MS } from "./apology-recorder-constants";
import { mixUkuleleApology } from "./ukulele-audio";
import { loadApologyMusic } from "./apology-music";

const MAX_WIDTH = 1280;
const DETECT_WIDTH = 320;
const SMOOTHING = 0.4;
// Where the ukulele's body sits in the 480x480 PNG, and how it's held.
const UKULELE_BODY = { x: 0.27, y: 0.5 };
const UKULELE_TILT = (-20 * Math.PI) / 180;

// Chrome has MediaStreamTrackProcessor, but TypeScript's DOM lib doesn't.
declare class MediaStreamTrackProcessor<T> {
  constructor(init: { track: MediaStreamTrack });
  readonly readable: ReadableStream<T>;
}

export class MicrophoneError extends Error {}

export type ApologyProgress = { stage: "recording"; remainingMs: number } | { stage: "processing"; fraction: number };

let handsLoading: Promise<HandLandmarker> | null = null;
let ukuleleLoading: Promise<ImageBitmap> | null = null;
// HandLandmarker's VIDEO mode needs ever-increasing timestamps, across recordings too.
let handClock = 0;

// Same MediaPipe runtime as the face detector, so the only extra download is the model.
export function loadHands() {
  if (handsLoading) return handsLoading;
  const load = (async () => {
    const files = await FilesetResolver.forVisionTasks(chrome.runtime.getURL("mediapipe"));
    const create = (delegate: "GPU" | "CPU") =>
      HandLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: chrome.runtime.getURL("models/hand_landmarker.task"), delegate },
        runningMode: "VIDEO",
        numHands: 2,
      });
    return create("GPU").catch(() => create("CPU"));
  })();
  handsLoading = load;
  load.catch(() => handsLoading === load && (handsLoading = null));
  return load;
}

export function loadUkulele() {
  if (ukuleleLoading) return ukuleleLoading;
  const load = fetch(chrome.runtime.getURL("photos/apology-ukelele.png"))
    .then((response) => response.blob())
    .then((blob) => createImageBitmap(blob));
  ukuleleLoading = load;
  load.catch(() => ukuleleLoading === load && (ukuleleLoading = null));
  return load;
}

export function warmApologyModels() {
  return Promise.all([loadHands(), loadUkulele(), loadApologyMusic()]);
}

type RawFrame = { jpeg: Promise<Blob>; ms: number };
type RawRecording = { frames: RawFrame[]; audio: Float32Array[]; sampleRate: number };
type Capture = RawRecording & { startedUs: number | null; done: () => void; onProgress: (remainingMs: number) => void };

export class ApologySession {
  private readonly videoReader: ReadableStreamDefaultReader<VideoFrame>;
  private readonly audioReader: ReadableStreamDefaultReader<AudioData>;
  private readonly recordCanvas = new OffscreenCanvas(1, 1);
  private capture: Capture | null = null;
  private closed = false;

  private constructor(
    private readonly camera: MediaStream,
    private readonly mic: MediaStream,
  ) {
    this.videoReader = new MediaStreamTrackProcessor<VideoFrame>({ track: camera.getVideoTracks()[0] }).readable.getReader();
    this.audioReader = new MediaStreamTrackProcessor<AudioData>({ track: mic.getAudioTracks()[0] }).readable.getReader();
    void this.pumpVideo();
    void this.pumpAudio();
  }

  // Its own camera stream, so the GIF loop opening and closing the camera can't end it mid-recording.
  static async open(deviceId: string) {
    void warmApologyModels().catch(() => {});
    const camera = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    const mic = await navigator.mediaDevices
      // voiceIsolation is Chrome's built-in background-voice/noise removal where the platform has it;
      // it's ignored elsewhere; noiseSuppression still requests microphone cleanup.
      .getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true, voiceIsolation: true } as MediaTrackConstraints })
      .catch((e) => {
        camera.getTracks().forEach((t) => t.stop());
        throw new MicrophoneError(String(e));
      });
    return new ApologySession(camera, mic);
  }

  get previewStream() { return this.camera; }

  async record(onProgress: (progress: ApologyProgress) => void) {
    if (this.capture) throw new Error("Already recording");
    const raw = await new Promise<RawRecording>((resolve) => {
      const capture: Capture = {
        frames: [],
        audio: [],
        sampleRate: 48000,
        startedUs: null,
        onProgress: (remainingMs) => onProgress({ stage: "recording", remainingMs }),
        done: () => {
          this.capture = null;
          resolve(capture);
        },
      };
      this.capture = capture;
    });
    return processApology(raw, (fraction) => onProgress({ stage: "processing", fraction }));
  }

  close() {
    this.closed = true;
    void this.videoReader.cancel().catch(() => {});
    void this.audioReader.cancel().catch(() => {});
    this.camera.getTracks().forEach((t) => t.stop());
    this.mic.getTracks().forEach((t) => t.stop());
  }

  private async pumpVideo() {
    while (!this.closed) {
      const { value: frame, done } = await this.videoReader.read().catch(() => ({ value: undefined, done: true }));
      if (done || !frame) return;
      try {
        this.onVideoFrame(frame);
      } finally {
        frame.close();
      }
    }
  }

  private async pumpAudio() {
    while (!this.closed) {
      const { value: data, done } = await this.audioReader.read().catch(() => ({ value: undefined, done: true }));
      if (done || !data) return;
      // Audio starts with the first recorded video frame, so the two line up.
      if (this.capture?.startedUs != null) {
        const samples = new Float32Array(data.numberOfFrames);
        data.copyTo(samples, { planeIndex: 0, format: "f32-planar" });
        this.capture.audio.push(samples);
        this.capture.sampleRate = data.sampleRate;
      }
      data.close();
    }
  }

  // Kept cheap on purpose: draw, then let the browser encode the JPEG off the main thread.
  private onVideoFrame(frame: VideoFrame) {
    const capture = this.capture;
    if (!capture) return;
    capture.startedUs ??= frame.timestamp;
    const ms = (frame.timestamp - capture.startedUs) / 1000;
    if (ms >= APOLOGY_MS) return capture.done();
    const scale = Math.min(1, MAX_WIDTH / frame.displayWidth);
    // Even dimensions keep the video encoder happy.
    const width = Math.round(frame.displayWidth * scale) & ~1;
    const height = Math.round(frame.displayHeight * scale) & ~1;
    if (this.recordCanvas.width !== width || this.recordCanvas.height !== height) [this.recordCanvas.width, this.recordCanvas.height] = [width, height];
    this.recordCanvas.getContext("2d")!.drawImage(frame, 0, 0, width, height);
    // convertToBlob snapshots the canvas immediately, so the next frame can reuse it.
    capture.frames.push({ jpeg: this.recordCanvas.convertToBlob({ type: "image/jpeg", quality: 0.9 }), ms });
    capture.onProgress(Math.max(0, APOLOGY_MS - ms));
  }
}

type Box = { cx: number; cy: number; w: number };
// Landmarks are only reused for a couple of frames; older ones would paste hands where they no longer are.
const HANDS_STALE_FRAMES = 2;

// Follows the hands across frames: tracking every 2nd frame, smoothed. No hands, no ukulele.
class UkulelePlacer {
  private box: Box | null = null;
  private landmarks: NormalizedLandmark[][] = [];
  private framesWithoutHands = Infinity;
  private readonly small = new OffscreenCanvas(1, 1);

  constructor(private readonly hands: HandLandmarker) {}

  place(image: ImageBitmap, index: number): { box: Box | null; hands: NormalizedLandmark[][] } {
    this.small.width = DETECT_WIDTH;
    this.small.height = Math.round((DETECT_WIDTH * image.height) / image.width);
    this.small.getContext("2d")!.drawImage(image, 0, 0, this.small.width, this.small.height);

    let target: Box | null = null;
    if (index % 2 === 1) target = this.findHands();
    const reappeared = target && this.framesWithoutHands > HANDS_STALE_FRAMES;
    this.framesWithoutHands = target ? 0 : this.framesWithoutHands + 1;
    if (this.framesWithoutHands > HANDS_STALE_FRAMES) {
      this.box = null;
      return { box: null, hands: [] };
    }
    // Hands coming back into view snap the ukulele to them instead of gliding from the old spot.
    if (!this.box || reappeared) this.box = target ? { ...target } : this.box;
    else if (target) {
      this.box.cx += (target.cx - this.box.cx) * SMOOTHING;
      this.box.cy += (target.cy - this.box.cy) * SMOOTHING;
      this.box.w += (target.w - this.box.w) * SMOOTHING;
    }
    return { box: this.box, hands: this.landmarks };
  }

  private findHands(): Box | null {
    handClock += 33;
    const { landmarks } = this.hands.detectForVideo(this.small, handClock);
    const points = landmarks.flat();
    if (!points.length) return null;
    this.landmarks = landmarks;
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX };
  }
}

function drawUkulele(ctx: OffscreenCanvasRenderingContext2D, ukulele: ImageBitmap, box: Box) {
  const { width, height } = ctx.canvas;
  const size = Math.min(0.85, Math.max(0.6, 2.2 * box.w)) * width;
  ctx.save();
  ctx.translate(box.cx * width, box.cy * height);
  ctx.rotate(UKULELE_TILT);
  ctx.drawImage(ukulele, -UKULELE_BODY.x * size, -UKULELE_BODY.y * size, size, size);
  ctx.restore();
}

// The hand shape is drawn at a quarter of the frame's resolution; stretching it back up softens
// its edge for free, so no blur filter is needed. Full-resolution work covers only the hands.
const MASK_SCALE = 0.25;
const handMask = new OffscreenCanvas(1, 1);
const handCutout = new OffscreenCanvas(1, 1);

// Pastes the hands from the original frame back over the ukulele, so the hands sit on top of it
// while the arms (outside the hand shape) stay underneath. The shape is the palm polygon plus a
// thick round stroke along every finger bone.
function drawHands(ctx: OffscreenCanvasRenderingContext2D, image: ImageBitmap, hands: NormalizedLandmark[][]) {
  if (!hands.length) return;
  const { width, height } = ctx.canvas;
  const [maskWidth, maskHeight] = [Math.ceil(width * MASK_SCALE), Math.ceil(height * MASK_SCALE)];
  if (handMask.width !== maskWidth || handMask.height !== maskHeight) [handMask.width, handMask.height] = [maskWidth, maskHeight];
  const mask = handMask.getContext("2d")!;
  mask.clearRect(0, 0, maskWidth, maskHeight);
  mask.fillStyle = mask.strokeStyle = "#fff";
  mask.lineCap = mask.lineJoin = "round";

  // The hands' bounding box (in full-resolution pixels), padded by the finger thickness.
  let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const hand of hands) {
    const p = hand.map(({ x, y }) => [x * maskWidth, y * maskHeight] as const);
    // Wrist to the base of the middle finger: roughly the palm's length.
    const palm = Math.hypot(p[0][0] - p[9][0], p[0][1] - p[9][1]);
    mask.lineWidth = palm * 0.3;
    mask.beginPath();
    for (const { start, end } of HandLandmarker.HAND_CONNECTIONS) {
      mask.moveTo(...p[start]);
      mask.lineTo(...p[end]);
    }
    mask.stroke();
    mask.beginPath();
    for (const [k, i] of [0, 1, 5, 9, 13, 17].entries()) (k ? mask.lineTo : mask.moveTo).call(mask, ...p[i]);
    mask.closePath();
    mask.fill();
    const pad = (mask.lineWidth / 2 + 2) / MASK_SCALE;
    for (const { x, y } of hand) {
      [left, right] = [Math.min(left, x * width - pad), Math.max(right, x * width + pad)];
      [top, bottom] = [Math.min(top, y * height - pad), Math.max(bottom, y * height + pad)];
    }
  }

  const [x, y] = [Math.max(0, Math.floor(left)), Math.max(0, Math.floor(top))];
  const [w, h] = [Math.min(width, Math.ceil(right)) - x, Math.min(height, Math.ceil(bottom)) - y];
  if (w <= 0 || h <= 0) return;
  if (handCutout.width !== w || handCutout.height !== h) [handCutout.width, handCutout.height] = [w, h];
  const cutout = handCutout.getContext("2d")!;
  cutout.globalCompositeOperation = "source-over";
  cutout.clearRect(0, 0, w, h);
  cutout.imageSmoothingQuality = "high";
  cutout.drawImage(handMask, x * MASK_SCALE, y * MASK_SCALE, w * MASK_SCALE, h * MASK_SCALE, 0, 0, w, h);
  cutout.globalCompositeOperation = "source-in";
  cutout.drawImage(image, x, y, w, h, 0, 0, w, h);
  ctx.drawImage(handCutout, x, y);
}

async function processApology(raw: RawRecording, onProgress: (fraction: number) => void) {
  const [hands, ukulele] = await warmApologyModels();
  const jpegs = await Promise.all(raw.frames.map((f) => f.jpeg));
  if (!jpegs.length) throw new Error("The camera recorded no frames");
  const first = await createImageBitmap(jpegs[0]);
  const [width, height] = [first.width, first.height];
  first.close();

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d")!;
  const videoCodec = await getFirstEncodableVideoCodec(["avc", "vp9", "av1"], { width, height });
  if (!videoCodec) throw new Error("This browser can't encode video");
  const video = new CanvasSource(canvas, { codec: videoCodec, quality: QUALITY_HIGH });
  output.addVideoTrack(video, { frameRate: 30 });

  const samples = Math.round(raw.sampleRate * APOLOGY_MS / 1000);
  const audioCodec = samples
    ? await getFirstEncodableAudioCodec(["aac", "opus"], { numberOfChannels: 1, sampleRate: raw.sampleRate })
    : null;
  const audio = audioCodec ? new AudioSampleSource({ codec: audioCodec, quality: QUALITY_HIGH }) : null;
  if (audio) output.addAudioTrack(audio);
  await output.start();

  let musicStartMs = APOLOGY_MS;
  const placer = new UkulelePlacer(hands);
  for (let i = 0; i < jpegs.length; i++) {
    const image = await createImageBitmap(jpegs[i]);
    ctx.drawImage(image, 0, 0, width, height);
    // The first frame stays untouched, so the chat's thumbnail looks like a sincere apology.
    if (i > 0) {
      const { box, hands } = placer.place(image, i);
      if (box) {
        musicStartMs = Math.min(musicStartMs, raw.frames[i].ms);
        drawUkulele(ctx, ukulele, box);
        drawHands(ctx, image, hands);
      }
    }
    image.close();
    const ms = raw.frames[i].ms;
    const next = raw.frames[i + 1]?.ms ?? APOLOGY_MS;
    await video.add(ms / 1000, Math.max(1, next - ms) / 1000);
    onProgress(0.9 * (i + 1) / jpegs.length);
  }

  if (audio) {
    const input = new Float32Array(samples);
    let offset = 0;
    for (const chunk of raw.audio) {
      const count = Math.min(chunk.length, samples - offset);
      if (count <= 0) break;
      input.set(chunk.subarray(0, count), offset);
      offset += count;
    }
    // Start the backing from its beginning when hands first reveal the ukulele.
    // If no hands appeared, preserve the original voice for the whole recording.
    const { backing, notes } = await loadApologyMusic(raw.sampleRate);
    const tuned = mixUkuleleApology(input, raw.sampleRate, backing, notes, Math.round((raw.sampleRate * musicStartMs) / 1000));
    for (let start = 0; start < tuned.length; start += raw.sampleRate) {
      const data = tuned.subarray(start, Math.min(tuned.length, start + raw.sampleRate));
      await audio.add(new AudioSample({ data, format: "f32-planar", numberOfChannels: 1, sampleRate: raw.sampleRate, timestamp: start / raw.sampleRate }));
    }
  }

  await output.finalize();
  onProgress(1);
  return { blob: new Blob([output.target.buffer!], { type: "video/mp4" }), mimeType: "video/mp4" };
}
