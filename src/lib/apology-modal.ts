import { ApologyPreview } from "./apology-preview";
// The apology modal, injected into the chat page by the content script (shadow DOM keeps the site's CSS out). It can't be dismissed:
// it stays until a 5-second apology video is recorded and sent. Recording happens in the
// offscreen page (which owns the camera); this only shows a preview and the controls.
import { APOLOGY_MS } from "./apology-recorder-constants";
import { send, type ApologyRequest, type ApologyUpdate } from "./messages";

const TITLE = "apologize.";
const BODY =
  "you have been suspended from sending messages for being too dishonest with your LMAOs and HAWHWAHAHAHs -- you must submit a formal apology (beg and plead) to continue chatting.";

// The entire modal and backdrop fade together as processing completes.
// The page behind is dimmed, and the backdrop takes every click and scroll so it can't be used.
const STYLE = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; border: 0; outline: none; box-shadow: none; animation: none; transition: none; }
.backdrop { position: fixed; inset: 0; z-index: 2147483647; display: flex; align-items: center; justify-content: center;
  padding: 16px; background: rgba(0, 0, 0, 0.4); overscroll-behavior: contain;
  color: #000; font: 14px/20px "Arial Narrow", Arial, sans-serif; -webkit-font-smoothing: antialiased; }
main { display: flex; flex-direction: column; gap: 16px; width: 100%; max-width: 28rem; max-height: 100%; overflow-y: auto;
  padding: 24px; background: #fff; }
h1 { font-size: 20px; line-height: 28px; font-weight: 700; }
.muted { color: #737373; }
.preview { position: relative; }
video { display: block; width: 100%; transform: scaleX(-1); }
.backdrop.processing { transition: opacity 1000ms linear; }
.processing-progress { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
@media (prefers-reduced-motion: reduce) { .backdrop.processing { transition: none; } }
[hidden], #status:empty { display: none; }
.links { display: flex; gap: 16px; }
button { background: none; color: inherit; font: inherit; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
button:disabled { color: #737373; cursor: default; }
`;

// Typing, pasting and dropping anywhere outside the modal are blocked while it's open.
const BLOCKED = ["keydown", "keypress", "keyup", "beforeinput", "input", "paste", "drop"];

export type DeliverApology = (dataUrl: string, mimeType: string, finishMs: number) => Promise<void>;

let active: Promise<void> | null = null;

export function showApologyModal(deliver: DeliverApology) {
  active ??= run(deliver).finally(() => (active = null));
  return active;
}

function run(deliver: DeliverApology) {
  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>${STYLE}</style>
    <div class="backdrop">
      <main role="dialog" aria-modal="true" aria-labelledby="title">
        <h1 id="title"></h1>
        <p id="body"></p>
        <div class="preview">
          <video aria-label="Camera preview" autoplay muted playsinline hidden></video>
          <div class="processing-progress" role="progressbar" aria-label="Processing your apology" aria-valuemin="0" aria-valuemax="100" hidden></div>
        </div>
        <p id="status" class="muted" aria-live="polite"></p>
        <div class="links">
          <button id="record" disabled>record apology</button>
          <button id="retry" hidden>try again</button>
          <button id="settings" hidden>open settings</button>
        </div>
      </main>
    </div>`;
  const $ = <T extends Element>(selector: string) => root.querySelector(selector) as T;
  $("#title").textContent = TITLE;
  $("#body").textContent = BODY;
  const preview = $<HTMLVideoElement>("video");
  preview.muted = true;
  const progress = $<HTMLDivElement>(".processing-progress");
  const status = $<HTMLParagraphElement>("#status");
  const record = $<HTMLButtonElement>("#record");
  const retry = $<HTMLButtonElement>("#retry");
  const settings = $<HTMLButtonElement>("#settings");

  const block = (event: Event) => {
    if (!event.isTrusted || event.composedPath().includes(host)) return;
    event.stopImmediatePropagation();
    event.preventDefault();
  };
  for (const type of BLOCKED) window.addEventListener(type, block, true);
  // Scrolling on the backdrop would otherwise scroll the chat behind it.
  const backdrop = $<HTMLDivElement>(".backdrop");
  const stopScroll = (event: Event) => event.target === backdrop && event.preventDefault();
  backdrop.addEventListener("wheel", stopScroll, { passive: false });
  backdrop.addEventListener("touchmove", stopScroll, { passive: false });
  document.documentElement.append(host);

  return new Promise<void>((resolve) => {
    let port: chrome.runtime.Port | null = null;
    let finished = false;
    let receiver: ApologyPreview | null = null;
    const resetFade = () => {
      backdrop.classList.remove("processing");
      backdrop.style.opacity = "1";
      progress.hidden = true;
      progress.removeAttribute("aria-valuenow");
    };
    const closePreview = () => {
      receiver?.close();
      receiver = null;
      preview.pause();
      preview.srcObject = null;
      preview.hidden = true;
    };

    // Resolves once the modal is fully transparent (right away when there's no fade to wait for).
    const fadedOut = () =>
      new Promise<void>((resolve) => {
        const started = performance.now();
        const check = () => {
          if (Number(getComputedStyle(backdrop).opacity) <= 0.001 || performance.now() - started > 1500) resolve();
          else requestAnimationFrame(check);
        };
        check();
      });

    const fail = (message: string, microphone = false) => {
      resetFade();
      status.textContent = message;
      record.disabled = true;
      retry.hidden = false;
      settings.hidden = !microphone;
    };

    const connect = async () => {
      resetFade();
      record.hidden = false;
      retry.hidden = settings.hidden = true;
      record.disabled = true;
      status.textContent = "Starting the camera…";
      await send({ type: "apology-prepare" }).catch(() => {});
      const current = chrome.runtime.connect({ name: "apology" });
      port = current;
      let cameraReady = false;
      let videoReady = false;
      const ready = () => {
        if (port !== current || finished || !cameraReady || !videoReady) return;
        status.textContent = "";
        record.disabled = false;
        record.focus();
      };
      const connection = new ApologyPreview(
        (signal) => { if (port === current) current.postMessage({ type: "preview-signal", signal } satisfies ApologyRequest); },
        (error) => { if (port === current && !finished) fail(String(error)); },
        (stream) => {
          if (port !== current || finished) return;
          preview.srcObject = stream;
          preview.hidden = false;
          void preview.play().then(() => { videoReady = true; ready(); }, (error) => {
            if (port === current && !finished) fail(`Couldn't play the camera preview: ${error}`);
          });
        },
      );
      receiver = connection;
      current.onDisconnect.addListener(() => {
        if (port === current) {
          closePreview();
          if (!finished) fail("Lost the connection to the camera.");
        }
      });
      current.onMessage.addListener(async (update: ApologyUpdate) => {
        if (port !== current || finished) return;
        switch (update.type) {
          case "preview-signal":
            void connection.receive(update.signal);
            return;
          case "ready":
            cameraReady = true;
            ready();
            return;
          case "progress":
            status.textContent = `Recording… ${Math.ceil(update.remainingMs / 1000)}`;
            return;
          case "processing": {
            const fraction = Math.max(0, Math.min(1, update.fraction));
            const percent = Math.round(fraction * 100);
            status.textContent = "";
            backdrop.classList.add("processing");
            backdrop.style.opacity = String(1 - fraction);
            progress.hidden = false;
            progress.setAttribute("aria-valuenow", String(percent));
            return;
          }
          case "error":
            return fail(update.message, update.microphone);
          case "done": {
            backdrop.style.opacity = "0";
            finished = true;
            status.textContent = "";
            // Send while the modal fades; the live preview (and the camera behind it) stays on
            // until the modal is fully faded out.
            const sent = deliver(update.dataUrl, update.mimeType, update.finishMs).then(() => null, (e: unknown) => e);
            await fadedOut();
            closePreview();
            current.disconnect();
            const error = await sent;
            if (error) {
              finished = false;
              return fail(`Couldn't send the apology: ${error}`);
            }
            send({ type: "apology-done" }).catch(() => {});
            for (const type of BLOCKED) window.removeEventListener(type, block, true);
            host.remove();
            resolve();
          }
        }
      });
    };

    record.addEventListener("click", () => {
      resetFade();
      record.hidden = true;
      record.disabled = true;
      status.textContent = `Recording… ${APOLOGY_MS / 1000}`;
      port?.postMessage({ type: "record" } satisfies ApologyRequest);
    });
    retry.addEventListener("click", () => {
      const previous = port;
      port = null;
      closePreview();
      previous?.disconnect();
      void connect();
    });
    settings.addEventListener("click", () => send({ type: "open-options" }).catch(() => {}));
    void connect();
  });
}
