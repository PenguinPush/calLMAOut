import { PHOTO_STYLE_VERSION } from "./lib/photo-overlays";
import { jevLaughProbability, looksLikeLaugh } from "./lib/detect";
import { send, type CaptureResult, type LogEntry, type Message, type PhotoAnalysis, type StrikeResult, type Verdict } from "./lib/messages";
import { getSettings } from "./lib/settings";

chrome.runtime.onInstalled.addListener(({ reason }) => {
  // The camera permission has to be granted once from a visible extension page.
  if (reason === "install") chrome.runtime.openOptionsPage();
  void syncSmileWatcher();
});

let creating: Promise<void> | null = null;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: "offscreen.html",
      reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.WEB_RTC],
      justification: "Take a webcam photo when you laugh",
    })
    .finally(() => (creating = null));
  await creating;
}

async function classify(text: string): Promise<Verdict> {
  const settings = await getSettings();
  if (!settings.enabled) return { laugh: false, why: "extension is off" };
  if (!text.trim()) return { laugh: false, why: "empty" };
  if (looksLikeLaugh(text)) return { laugh: true, why: "matched locally" };
  if (!settings.apiKey) return { laugh: false, why: "no local match, and no Jev key" };
  try {
    const p = await jevLaughProbability(text, settings.apiKey, AbortSignal.timeout(2000));
    return { laugh: p >= settings.threshold, why: `Jev ${p.toFixed(2)} (threshold ${settings.threshold})` };
  } catch (e) {
    return { laugh: false, why: `Jev failed: ${e}` };
  }
}

// Appends are chained so concurrent log messages don't overwrite each other.
let logging = Promise.resolve();

function log(where: string, text: string) {
  logging = logging.then(async () => {
    const { log = [] } = (await chrome.storage.local.get("log")) as { log?: LogEntry[] };
    await chrome.storage.local.set({ log: [...log, { at: Date.now(), where, text }].slice(-60) });
  });
}

async function capture(): Promise<CaptureResult> {
  const { enabled, deviceId, smileThreshold, rememberSmiles, smileMemoryMs } = await getSettings();
  if (!enabled) return { error: "Extension is off" };
  await ensureOffscreen();
  const result = await send<CaptureResult>({ type: "offscreen-capture", config: { deviceId, threshold: smileThreshold, rememberSmiles, smileMemoryMs } });
  // Saved for the popup in the background; the page shouldn't wait on it.
  if ("dataUrl" in result) {
    const photoId = crypto.randomUUID();
    void chrome.storage.local.set({ lastPhoto: result.dataUrl, lastPhotoStyleVersion: PHOTO_STYLE_VERSION, lastPhotoAt: Date.now(), lastPhotoId: photoId, lastPhotoAnalysis: { photoId, result: result.analysis } });

  }
  return result;
}

// Starts, updates or stops the always-on smile watcher to match the settings.
async function syncSmileWatcher() {
  const { enabled, rememberSmiles, deviceId, smileThreshold, smileMemoryMs } = await getSettings();
  const on = enabled;
  if (!on && !(await chrome.offscreen.hasDocument())) return;
  await ensureOffscreen();
  await send({ type: "offscreen-watch", config: on ? { deviceId, threshold: smileThreshold, rememberSmiles, smileMemoryMs } : null });
}

chrome.runtime.onStartup.addListener(() => void syncSmileWatcher());
chrome.storage.local.onChanged.addListener((changes) => {
  if (["enabled", "rememberSmiles", "deviceId", "smileThreshold", "smileMemoryMs"].some((key) => key in changes)) void syncSmileWatcher();
});

// Called only after a confirmed send. Passive camera detections never reset the streak.
async function strike(analysis: PhotoAnalysis["result"], laugh: boolean): Promise<StrikeResult> {
  const { enabled, apologyStrikes, smileThreshold } = await getSettings();
  const state = (await chrome.storage.local.get({ strikeCount: 0, apologyDue: false })) as { strikeCount: number; apologyDue: boolean };
  if (!enabled || "error" in analysis || !analysis.face) return { apologyDue: state.apologyDue };
  if (analysis.smile >= smileThreshold) {
    if (state.strikeCount) await chrome.storage.local.set({ strikeCount: 0 });
    return { apologyDue: state.apologyDue };
  }
  if (!laugh) return { apologyDue: state.apologyDue };
  const strikeCount = state.strikeCount + 1;
  const apologyDue = state.apologyDue || (apologyStrikes > 0 && strikeCount >= apologyStrikes);
  await chrome.storage.local.set({ strikeCount, apologyDue });
  log("strikes", `Strike ${strikeCount}${apologyStrikes > 0 ? ` of ${apologyStrikes}` : ""}: not smiling (${analysis.smile.toFixed(2)})`);
  if (apologyDue && !state.apologyDue) log("strikes", "Apology required");
  return { apologyDue };
}

async function warm() {
  const { enabled, deviceId, smileThreshold, rememberSmiles, smileMemoryMs } = await getSettings();
  if (!enabled) return;
  await ensureOffscreen();
  await send({ type: "offscreen-warm", config: { deviceId, threshold: smileThreshold, rememberSmiles, smileMemoryMs } });
}

chrome.runtime.onMessage.addListener((message: Message, sender, respond) => {
  switch (message.type) {
    case "log":
      log(sender.url ? new URL(sender.url).host : "extension", message.text);
      return;
    case "classify":
      classify(message.text).then(respond);
      return true;
    case "capture":
      capture().then(respond, (e) => respond({ error: String(e) }));
      return true;
    case "typing":
      // Also restarts the watcher if it stopped (e.g. before camera permission was granted).
      void syncSmileWatcher()
        .then(() => send({ type: "offscreen-typing" }))
        .catch(() => {});
      return;
    case "forget-smile":
      void chrome.offscreen.hasDocument().then((open) => open && send({ type: "offscreen-forget" }));
      return;
    case "message-face":
      chrome.offscreen.hasDocument()
        .then((open) => open ? send({ type: "offscreen-message-face" }) : null)
        .then(respond, () => respond(null));
      return true;
    case "strike":
      strike(message.analysis, message.laugh).then(respond, () => respond({ apologyDue: false }));
      return true;
    case "apology-prepare":
      syncSmileWatcher().then(() => respond(null), () => respond(null));
      return true;
    case "apology-done":
      void chrome.storage.local.set({ strikeCount: 0, apologyDue: false });
      log("strikes", "Apology sent, strikes reset");
      return;
    case "open-options":
      void chrome.runtime.openOptionsPage();
      return;
    case "warm":
      warm().then(
        () => respond(null),
        (e) => (log("camera", `Camera warm-up failed: ${e}`), respond(null)),
      );
      return true;
  }
});
