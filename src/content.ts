import { showApologyModal } from "./lib/apology-modal";
import { looksLikeLaugh } from "./lib/detect";
import { send, type CaptureResult, type Message, type PhotoAnalysis, type StrikeResult, type Verdict } from "./lib/messages";
import { getSettings } from "./lib/settings";

type Editable = HTMLTextAreaElement | HTMLInputElement | HTMLElement;

const SEND_BUTTON = /\bsend\b/i;
const PREVIEW = 'img[src^="blob:"], img[src^="data:"]';

let lastEditable: Editable | null = null;
let busy = false;

// Text classified while you type, so pressing Enter doesn't wait on the network.
const verdicts = new Map<string, Promise<Verdict>>();

function classify(text: string) {
  text = text.trim();
  let verdict = verdicts.get(text);
  if (!verdict) {
    verdict = send<Verdict>({ type: "classify", text }).catch((e) => ({ laugh: false, why: `extension unreachable: ${e}` }));
    verdicts.set(text, verdict);
    // Only keep real answers, so turning it on or fixing a key takes effect immediately.
    verdict.then((v) => v.laugh || v.why.startsWith("Jev ") || verdicts.delete(text));
    if (verdicts.size > 50) verdicts.delete(verdicts.keys().next().value!);
  }
  return verdict;
}

// Shows up in the activity log on the settings page.
function log(text: string) {
  send({ type: "log", text }).catch(() => {});
}

// Lets the settings page see which tabs have the content script.
chrome.runtime.onMessage.addListener((message: Message, _sender, respond) => {
  if (message.type === "ping" && window === window.top) respond(location.host);
});

function editableFrom(event: Event): Editable | null {
  const target = event.composedPath()[0];
  if (target instanceof HTMLTextAreaElement) return target;
  if (target instanceof HTMLInputElement) return /^(text|search|)$/.test(target.type) ? target : null;
  if (!(target instanceof HTMLElement) || !target.isContentEditable) return null;
  let root = target;
  while (root.parentElement?.isContentEditable) root = root.parentElement;
  return root;
}

function textOf(el: Editable) {
  return "value" in el ? el.value : el.innerText;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Resolves as soon as the site clears the box, or false if it never does
// (then Enter was just a newline, not a send).
async function cleared(el: Editable, text: string, timeout: number) {
  for (const start = performance.now(); performance.now() - start < timeout; await sleep(10)) {
    if (textOf(el).trim() !== text.trim()) return true;
  }
  return false;
}

// Resolves once the site renders an image preview of the pasted photo, so we can
// send right away instead of guessing how long it takes. Must be armed before pasting.
function previewRendered(timeout: number) {
  return new Promise<boolean>((resolve) => {
    const done = (seen: boolean) => {
      observer.disconnect();
      clearTimeout(timer);
      requestAnimationFrame(() => resolve(seen));
    };
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        const nodes = r.type === "attributes" ? [r.target] : [...r.addedNodes];
        if (nodes.some((n) => n instanceof Element && (n.matches(PREVIEW) || n.querySelector(PREVIEW)))) return done(true);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
    const timer = setTimeout(() => done(false), timeout);
  });
}

let typingTimer: ReturnType<typeof setTimeout> | undefined;
let warmedAt = -Infinity;
let typedAt = -Infinity;

// Each keystroke restarts the 3s smile memory; a few updates a second is plenty.
function noteTyping() {
  if (performance.now() - typedAt < 250) return;
  typedAt = performance.now();
  send({ type: "typing" }).catch(() => {});
}

function warm() {
  if (performance.now() - warmedAt < 5000) return;
  warmedAt = performance.now();
  send({ type: "warm" });
}

document.addEventListener(
  "input",
  (event) => {
    const el = editableFrom(event);
    if (!el) return;
    lastEditable = el;
    noteTyping();
    // Obvious laughs open the camera on the keystroke itself.
    if (looksLikeLaugh(textOf(el))) warm();
    clearTimeout(typingTimer);
    typingTimer = setTimeout(async () => {
      if ((await classify(textOf(el))).laugh) warm();
    }, 120);
  },
  true,
);

document.addEventListener("focusin", (event) => (lastEditable = editableFrom(event) ?? lastEditable), true);

document.addEventListener(
  "keydown",
  (event) => {
    if (!event.isTrusted || event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    const el = editableFrom(event);
    if (el) onSend(el, "enter");
  },
  true,
);

document.addEventListener(
  "click",
  (event) => {
    if (!event.isTrusted || !lastEditable) return;
    const button = (event.composedPath()[0] as Element).closest?.("button, [role=button]");
    if (button && isSendButton(button)) onSend(lastEditable, button);
  },
  true,
);

function isSendButton(el: Element) {
  const label = [el.getAttribute("aria-label"), el.getAttribute("title"), el.getAttribute("data-testid")].join(" ");
  return SEND_BUTTON.test(label) || (el instanceof HTMLButtonElement && el.type === "submit" && SEND_BUTTON.test(el.textContent ?? ""));
}

async function onSend(el: Editable, via: "enter" | Element) {
  const text = textOf(el);
  if (busy || !text.trim()) return;
  busy = true;
  try {
    const start = performance.now();
    const ms = () => `${Math.round(performance.now() - start)}ms`;
    // Snapshot the active smile before classification or capture can consume it.
    const sentFace = send<PhotoAnalysis["result"] | null>({ type: "message-face" }).catch(() => null);
    const verdict = classify(text);
    const owed = chrome.storage.local.get({ apologyDue: false });
    // Fetch a prepared photo in parallel, unless an apology is already due.
    const photo = Promise.all([verdict, owed]).then(([v, state]) =>
      v.laugh && !state.apologyDue ? send<CaptureResult>({ type: "capture" }) : null,
    );
    const settings = getSettings();

    const { laugh, why } = await verdict;
    log(`${via === "enter" ? "Enter" : "Send click"} on "${text.trim().slice(0, 60)}": ${laugh ? "laugh" : "not a laugh"} (${why})`);
    if (!(await cleared(el, text, 300))) return log("Stopped: the box wasn't cleared, so the site didn't send (newline or not a chat box)");
    if ((await owed).apologyDue) {
      log("GIF skipped: an apology is due");
      await apologize(el, via);
      return;
    }
    if (!laugh) {
      const analysis = await sentFace;
      if (analysis) await send<StrikeResult>({ type: "strike", analysis, laugh: false }).catch(() => {});
      send({ type: "forget-smile" }).catch(() => {});
      return;
    }

    const result = await photo;
    if (!result) return;
    if ("error" in result) return log(`Stopped: photo failed: ${result.error}`);
    const { remembered } = result;
    log(
      remembered
        ? `Using your smile from ${(remembered.ageMs / 1000).toFixed(1)}s ago (${remembered.smile.toFixed(2)}), ${ms()}`
        : `Prepared ${result.entrance} → ${result.effect} GIF ready, source ${(result.sourceAgeMs / 1000).toFixed(1)}s old, ${ms()}`,
    );
    const { autoSend, sendDelay, skipSmiles, smileThreshold } = await settings;
    const { analysis } = result;
    // Resolve the strike before attaching anything: the threshold-triggering
    // message opens the apology modal instead of sending (or staging) a GIF.
    const { apologyDue } = await send<StrikeResult>({ type: "strike", analysis, laugh: true })
      .catch(() => chrome.storage.local.get({ apologyDue: false }));
    if (apologyDue) {
      log("GIF skipped: this message requires an apology");
      await apologize(el, via);
      return;
    }
    if (skipSmiles && "face" in analysis && analysis.face && analysis.smile >= smileThreshold) {
      return log(`Not sent: the photo counts as smiling (${analysis.smile.toFixed(2)}), and smiling photos are turned off`);
    }
    const target = el.isConnected ? el : lastEditable;
    if (!target) return log("Stopped: the chat box disappeared after sending");
    const rendered = previewRendered(600);
    log(await attach(target, result.dataUrl));
    if (!autoSend) return log("Auto-send is off, photo left attached");
    log((await rendered) ? `Preview appeared, ${ms()}` : "No preview appeared within 600ms, sending anyway");
    if (sendDelay > 0) await sleep(sendDelay);
    log(`Sent by ${submit(target, via)}, ${ms()}`);
  } finally {
    busy = false;
  }
}

// Shows the apology modal; the finished video is sent in the same chat box.
function apologize(el: Editable, via: "enter" | Element) {
  return showApologyModal(async (dataUrl, mimeType, finishMs) => {
    const target = el.isConnected ? el : lastEditable;
    if (!target) throw new Error("the chat box disappeared");
    log(`Apology recorded (${mimeType}), ready ${finishMs}ms after recording ended`);
    log(await attach(target, dataUrl));
    // Video attachments take longer than images for sites to accept.
    await sleep(Math.max(700, (await getSettings()).sendDelay));
    log(`Apology sent by ${submit(target, via)}`);
  });
}

async function attach(el: Editable, dataUrl: string) {
  const blob = await (await fetch(dataUrl)).blob();
  const extension = { "image/gif": "gif", "video/mp4": "mp4", "video/webm": "webm" }[blob.type] ?? "jpg";
  const file = new File([blob], `callmaout-${Date.now()}.${extension}`, { type: blob.type });
  const data = new DataTransfer();
  data.items.add(file);

  el.focus();
  const paste = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true, composed: true });
  el.dispatchEvent(paste);
  if (paste.defaultPrevented) return `Pasted (${Math.round(blob.size / 1024)} KB), the site accepted it`;

  // The site ignored the paste; fall back to its file picker.
  const scope = el.closest("form") ?? document;
  const input = scope.querySelector<HTMLInputElement>(`input[type=file]:not([accept]), input[type=file][accept*="${blob.type.split("/")[0]}"]`);
  if (!input) return "The site ignored the paste and has no file input, so the photo may not be attached";
  input.files = data.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return "The site ignored the paste, used its file input instead";
}

function submit(el: Editable, via: "enter" | Element) {
  if (via instanceof HTMLElement && via.isConnected) {
    via.click();
    return "clicking Send";
  }
  el.focus();
  for (const type of ["keydown", "keypress", "keyup"]) {
    el.dispatchEvent(
      new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true }),
    );
  }
  return "pressing Enter";
}
