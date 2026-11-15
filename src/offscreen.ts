import { ApologyPreview } from "./lib/apology-preview";
import type { Transition } from "./lib/gif-transitions";
import { analyzeFace, loadFace } from "./lib/face";
import { drawPhotoStickers, loadStickers } from "./lib/photo-overlays";
import { encodeGif, stopGifWorker, warmGifWorker } from "./lib/gif-client";
import { PreparedCache } from "./lib/prepared-cache";
import { ApologySession, MicrophoneError, warmApologyModels } from "./lib/apology-recorder";
import type { AnalyzeResult, ApologyRequest, ApologyUpdate, CaptureResult, FaceResult, Message, RememberedPhoto, WatchConfig } from "./lib/messages";

// Keeps the camera open for a bit after use so back-to-back laughs are instant.
const KEEP_WARM_MS = 20_000;

const video = document.getElementById("video") as HTMLVideoElement;

let stream: MediaStream | null = null;
let streamDeviceId = "";
let openedAt = 0;
let stopTimer: ReturnType<typeof setTimeout> | undefined;
// A warm-up and a capture often arrive together; they must share one camera open.
let opening: Promise<void> | null = null;

function stop() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}

async function open(deviceId: string) {
  clearTimeout(stopTimer);
  stopTimer = setTimeout(stop, KEEP_WARM_MS);
  while (opening) await opening.catch(() => {});
  if (stream?.active && streamDeviceId === deviceId && video.videoWidth) return;
  opening = (async () => {
    stop();
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
    // Permission/model loading may finish after the extension was switched off.
    if (!watchConfig) {
      stop();
      return;
    }
    streamDeviceId = deviceId;
    openedAt = performance.now();
    video.srcObject = stream;
    await video.play();
  })().finally(() => (opening = null));
  await opening;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A freshly opened camera needs a moment to settle exposure.
async function settled() {
  const settle = 400 - (performance.now() - openedAt);
  if (settle > 0) await sleep(settle);
  if (!video.videoWidth) throw new Error("Camera opened but produced no frames");
}

function grab(target: HTMLCanvasElement, source: CanvasImageSource, width: number, height: number) {
  target.width = width;
  target.height = height;
  target.getContext("2d")!.drawImage(source, 0, 0);
}

type PreparedPhoto = {
  at: number;
  smiling: boolean;
  result: FaceResult;
  dataUrl: string;
  effect: Transition;
  entrance: Transition;
  durationMs: number;
  encodeMs: number;
  prepareMs: number;
};
const prepared = new PreparedCache<PreparedPhoto>();
let watchConfig: WatchConfig | null = null;
let loop: Promise<void> | null = null;
let lastCaptured: FaceResult | null = null;
let preparationError = "";
const waiters = new Set<() => void>();
const notify = () => { for (const wake of waiters) wake(); };

// Settings that change what's prepared; smile memory only changes how long a smile is kept.
const preparationKey = (config: WatchConfig | null) => config && JSON.stringify([config.deviceId, config.threshold, config.rememberSmiles]);

function watch(config: WatchConfig | null) {
  if (config) prepared.memoryMs = config.smileMemoryMs;
  const changed = preparationKey(config) !== preparationKey(watchConfig);
  if (!changed && config) watchConfig = config;
  if (changed) {
    watchConfig = config;
    prepared.clear();
    preparationError = "";
    lastCaptured = null;
    stopGifWorker();
    if (config) void warmGifWorker().catch(() => {});
    notify();
  }
  if (!config) {
    clearTimeout(stopTimer);
    stop();
    return;
  }
  if (!loop) {
    const running = prepareLoop();
    loop = running;
    void running.finally(() => {
      if (loop === running) loop = null;
      if (watchConfig) watch(watchConfig);
    });
  }
}

// GIF preparation pauses while an apology is being recorded, to leave it the CPU.
let apologyActive = false;

async function prepareLoop() {
  while (watchConfig) {
    if (apologyActive) {
      await sleep(100);
      continue;
    }
    const config = watchConfig;
    const generation = prepared.generation;
    try {
      await Promise.all([open(config.deviceId), loadFace(), loadStickers()]);
      await settled();
      if (watchConfig !== config) {
        if (!watchConfig) stop();
        continue;
      }
      const started = performance.now();
      const source = document.createElement("canvas");
      const scale = Math.min(1, 480 / Math.max(video.videoWidth, video.videoHeight));
      source.width = Math.max(1, Math.round(video.videoWidth * scale));
      source.height = Math.max(1, Math.round(video.videoHeight * scale));
      source.getContext("2d")!.drawImage(video, 0, 0, source.width, source.height);
      // Only clean camera pixels enter detection. No decorated frame is analyzed.
      const result = await analyzeFace(source);
      if (watchConfig !== config || prepared.generation !== generation) continue;
      const output = document.createElement("canvas");
      grab(output, source, source.width, source.height);
      await drawPhotoStickers(output.getContext("2d")!, result.face ? result.boxes : [], result, config.threshold);
      const encoded = await encodeGif(output);
      if (watchConfig !== config) continue;
      prepared.publish({
        ...encoded, result, at: started,
        smiling: result.face && result.smile >= config.threshold,
        prepareMs: Math.round(performance.now() - started),
      }, generation);
      preparationError = "";
      notify();
      // Backpressure: only grab the next photo once this GIF is complete.
      await sleep(0);
    } catch (error) {
      // Cancelled because the apology modal opened, or the settings changed: not a failure.
      if (watchConfig !== config || apologyActive) continue;
      preparationError = String(error);
      notify();
      console.warn("calLMAOut: GIF preparation failed", error);
      await sleep(1000);
    }
  }
}

function previewRemembered(): RememberedPhoto {
  const ready = prepared.ready(performance.now(), watchConfig?.rememberSmiles ?? false);
  if (!ready) return null;
  return {
    dataUrl: ready.photo.dataUrl,
    ageMs: Math.round(performance.now() - ready.photo.at),
    remembered: ready.remembered,
    effect: ready.photo.effect,
    entrance: ready.photo.entrance,
    durationMs: ready.photo.durationMs,
    prepareMs: ready.photo.prepareMs,
  };
}

async function capture(config: WatchConfig): Promise<CaptureResult> {
  watch(config);
  let ready = prepared.ready(performance.now(), config.rememberSmiles);
  // The normal path is a cache read. Only cold startup waits for the first GIF.
  if (!ready) {
    const deadline = performance.now() + 20000;
    while (!ready) {
      if (watchConfig?.deviceId !== config.deviceId || watchConfig.threshold !== config.threshold || watchConfig.rememberSmiles !== config.rememberSmiles) throw new Error("Camera settings changed during GIF preparation");
      if (preparationError) throw new Error(preparationError);
      if (performance.now() >= deadline) throw new Error("The first GIF is still preparing; try again shortly");
      await new Promise<void>((resolve) => {
        const wake = () => { clearTimeout(timer); waiters.delete(wake); resolve(); };
        const timer = setTimeout(wake, 250);
        waiters.add(wake);
      });
      ready = prepared.ready(performance.now(), config.rememberSmiles);
    }
  }
  const { photo, remembered } = ready;
  lastCaptured = photo.result;
  const ageMs = Math.round(performance.now() - photo.at);
  // Invalidate an in-flight pre-send frame too, so it cannot restore this smile.
  prepared.forget();
  const analysis = photo.result.face ? { face: true as const, smile: photo.result.smile } : { face: false as const };
  return {
    dataUrl: photo.dataUrl, analysis, mimeType: "image/gif", effect: photo.effect, entrance: photo.entrance, durationMs: photo.durationMs,
    prepareMs: photo.prepareMs, sourceAgeMs: ageMs,
    ...(remembered && photo.result.face ? { remembered: { smile: photo.result.smile, ageMs } } : {}),
  };
}

async function analyze(image?: string): Promise<AnalyzeResult> {
  if (!image) {
    if (!lastCaptured) throw new Error("No photo taken yet");
    return lastCaptured;
  }
  // img.decode() can stall in a hidden offscreen document; createImageBitmap doesn't need rendering.
  const bitmap = await createImageBitmap(await (await fetch(image)).blob());
  const given = document.createElement("canvas");
  given.width = bitmap.width;
  given.height = bitmap.height;
  given.getContext("2d")!.drawImage(bitmap, 0, 0);
  bitmap.close();
  return analyzeFace(given);
}

chrome.runtime.onMessage.addListener((message: Message, _sender, respond) => {
  switch (message.type) {
    case "offscreen-message-face": {
      const ready = watchConfig && prepared.ready(performance.now(), watchConfig.rememberSmiles);
      const result = ready?.photo.result;
      respond(result?.face ? { face: true, smile: result.smile } : null);
      return;
    }
    case "offscreen-remembered":
      respond(previewRemembered());
      return;
    case "offscreen-capture":
      capture(message.config).then(respond, (e) => respond({ error: String(e) }));
      return true;
    case "offscreen-analyze":
      analyze(message.image).then(respond, (e) => respond({ error: String(e) }));
      return true;
    case "offscreen-watch":
      watch(message.config);
      return;
    case "offscreen-typing":
      prepared.typed(performance.now());
      return;
    case "offscreen-forget":
      prepared.forget();
      return;
    case "offscreen-warm":
      void loadFace().catch(() => {});
      void loadStickers().catch(() => {});
      watch(message.config);
      respond(null);
      return true;
  }
});

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// The apology modal connects here for recording and native webcam preview signaling.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "apology") return;
  const post = (update: ApologyUpdate) => {
    try {
      port.postMessage(update);
    } catch {
      // The modal went away.
    }
  };
  const preview = new ApologyPreview(
    (signal) => post({ type: "preview-signal", signal }),
    (error) => post({ type: "error", message: String(error) }),
  );
  let session: ApologySession | null = null;
  let closed = false;
  // GIF preparation is off while the modal is open: cancel the one in progress too.
  apologyActive = true;
  stopGifWorker();
  port.onDisconnect.addListener(() => {
    closed = true;
    preview.close();
    session?.close();
    apologyActive = false;
    if (watchConfig) void warmGifWorker().catch(() => {});
  });

  void (async () => {
    if (!watchConfig) throw new Error("Turn calLMAOut on to record your apology");
    const opened = await ApologySession.open(watchConfig.deviceId);
    if (closed) return opened.close();
    session = opened;
    await preview.offer(opened.previewStream);
    await warmApologyModels();
    if (!closed) post({ type: "ready" });
  })().catch((e) =>
    post(
      e instanceof MicrophoneError
        ? { type: "error", message: `Microphone unavailable (${e.message}). Allow it in calLMAOut settings.`, microphone: true }
        : { type: "error", message: String(e) },
    ),
  );

  port.onMessage.addListener((message: ApologyRequest) => {
    if (message.type === "preview-signal") {
      void preview.receive(message.signal);
      return;
    }
    if (message.type !== "record" || !session) return;
    // Time from the last recorded frame to a finished video: the processing cost.
    let endedAt = 0;
    session
      .record((progress) => {
        if (progress.stage === "processing") return post({ type: "processing", fraction: progress.fraction });
        endedAt = performance.now();
        post({ type: "progress", remainingMs: progress.remainingMs });
      })
      .then(async ({ blob, mimeType }) => {
        const dataUrl = await blobToDataUrl(blob);
        post({ type: "done", dataUrl, mimeType, finishMs: Math.round(performance.now() - endedAt) });
      })
      .catch((e) => post({ type: "error", message: String(e) }));
  });
});
