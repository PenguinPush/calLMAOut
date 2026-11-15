import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CameraPreview } from "./lib/CameraPreview";
import { jevLaughProbability, looksLikeLaugh } from "./lib/detect";
import { send, type AnalyzeResult, type CaptureResult, type LogEntry, type RememberedPhoto } from "./lib/messages";
import { useSettings } from "./lib/useSettings";
import "./styles.css";

// Lets you type freely (even clear it) and only validates once you leave the box.
function NumberField({
  value,
  onCommit,
  min = -Infinity,
  max = Infinity,
  integer = false,
  disabled,
  className,
}: {
  value: number;
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  integer?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  const [saved, setSaved] = useState(value);
  // Pick up the stored value when settings finish loading.
  if (value !== saved) {
    setSaved(value);
    setDraft(String(value));
  }

  function commit() {
    let n = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(n)) return setDraft(String(value));
    n = Math.min(max, Math.max(min, integer ? Math.round(n) : n));
    setDraft(String(n));
    if (n !== value) onCommit(n);
  }

  return (
    <input
      type="text"
      inputMode={integer ? "numeric" : "decimal"}
      className={className}
      disabled={disabled}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
    />
  );
}

function Options() {
  const [settings, update] = useSettings();
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [cameraError, setCameraError] = useState("");
  const [test, setTest] = useState("");
  const [result, setResult] = useState("");
  const video = useRef<HTMLVideoElement>(null);
  const [checks, setChecks] = useState<[string, boolean | null, string][]>([]);
  const [testPhoto, setTestPhoto] = useState("");
  const [testCrop, setTestCrop] = useState("");
  const [rememberedPhoto, setRememberedPhoto] = useState<RememberedPhoto>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [strikes, setStrikes] = useState({ strikeCount: 0, apologyDue: false });
  const [microphone, setMicrophone] = useState("");

  useEffect(() => {
    chrome.storage.local.get({ strikeCount: 0, apologyDue: false }).then((state) => setStrikes(state as typeof strikes));
    const onChange = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes.strikeCount || changes.apologyDue)
        chrome.storage.local.get({ strikeCount: 0, apologyDue: false }).then((state) => setStrikes(state as typeof strikes));
    };
    chrome.storage.local.onChanged.addListener(onChange);
    navigator.permissions.query({ name: "microphone" as PermissionName }).then((status) => {
      setMicrophone(status.state);
      status.onchange = () => setMicrophone(status.state);
    });
    return () => chrome.storage.local.onChanged.removeListener(onChange);
  }, []);

  // The offscreen recorder can't ask for the microphone itself, so it's granted here once.
  async function allowMicrophone() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setMicrophone("granted");
    } catch (e) {
      setMicrophone(String(e));
    }
  }

  useEffect(() => {
    chrome.storage.local.get("log").then(({ log }) => setLog((log as LogEntry[]) ?? []));
    const onChange = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes.log) setLog((changes.log.newValue as LogEntry[]) ?? []);
    };
    chrome.storage.local.onChanged.addListener(onChange);
    return () => chrome.storage.local.onChanged.removeListener(onChange);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      const photo = settings.enabled && !document.hidden
        ? await send<RememberedPhoto>({ type: "offscreen-remembered" }).catch(() => null)
        : null;
      if (cancelled) return;
      setRememberedPhoto(photo ?? null);
      // Let the current GIF finish its transition before replacing its source.
      timer = setTimeout(() => void refresh(), photo ? photo.durationMs + 100 : 500);
    };
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [settings.enabled, settings.rememberSmiles, settings.deviceId]);

  // Opening the camera here grants the permission the offscreen capture page relies on.
  useEffect(() => {
    let stream: MediaStream | undefined;
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({ video: settings.deviceId ? { deviceId: { exact: settings.deviceId } } : true })
      .then(async (s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        if (video.current) video.current.srcObject = s;
        setCameraError("");
        setCameras((await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput"));
      })
      .catch((e) => setCameraError(String(e)));
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [settings.deviceId]);

  async function runChecks() {
    const results: typeof checks = [];
    const report = (name: string, ok: boolean | null, detail: string) => {
      results.push([name, ok, detail]);
      setChecks([...results]);
    };
    setTestPhoto("");
    setTestCrop("");

    report("Turned on", settings.enabled, settings.enabled ? "" : "Turn it on under Sending");

    const camera = await navigator.permissions.query({ name: "camera" as PermissionName });
    report("Camera permission", camera.state === "granted", camera.state === "granted" ? "" : `${camera.state}, allow the camera for this page`);
    const mic = await navigator.permissions.query({ name: "microphone" as PermissionName });
    report("Microphone permission", mic.state === "granted", mic.state === "granted" ? "" : `${mic.state}, needed for apology videos. Click Allow microphone under Apology`);

    let start = performance.now();
    try {
      const verdict = await send<{ laugh: boolean; why: string }>({ type: "classify", text: "lmao" });
      report("Background worker", true, `answered in ${Math.round(performance.now() - start)}ms (${verdict.why})`);
    } catch (e) {
      report("Background worker", false, `${e}. Reload the extension in chrome://extensions`);
    }

    start = performance.now();
    try {
      const photo = await send<CaptureResult>({ type: "capture" });
      if ("error" in photo) throw photo.error;
      setTestPhoto(photo.dataUrl);
      report("Photo", true, `taken in ${Math.round(performance.now() - start)}ms, ${Math.round((photo.dataUrl.length * 0.75) / 1024)} KB`);
    } catch (e) {
      report("Photo", false, String(e));
    }

    try {
      const model = await (await fetch(chrome.runtime.getURL("models/smile.json"))).json();
      const accuracy = `model is ${Math.round(model.crossValidatedAccuracy * 1000) / 10}% accurate on unseen FEI faces`;
      const result = await send<AnalyzeResult>({ type: "offscreen-analyze" });
      if ("error" in result) throw result.error;
      if (!result.face) {
        report("Smile check", false, `no face found in the photo (${accuracy})`);
      } else {
        setTestCrop(result.crop);
        const smiling = result.smile >= settings.smileThreshold;
        report("Smile check", true, `${smiling ? "smiling" : "not smiling"} (${result.smile.toFixed(2)}) in ${result.ms}ms, ${accuracy}`);
      }
    } catch (e) {
      report("Smile check", false, String(e));
    }

    if (!settings.apiKey) {
      report("Jev", null, "no key, so only obvious laughs are caught");
    } else {
      start = performance.now();
      try {
        const p = await jevLaughProbability("asdfjkl STOPPP 😭 i'm crying", settings.apiKey);
        report("Jev", p >= settings.threshold, `"asdfjkl STOPPP 😭 i'm crying" scored ${p.toFixed(2)} in ${Math.round(performance.now() - start)}ms`);
      } catch (e) {
        report("Jev", false, String(e));
      }
    }

    const self = await chrome.tabs.getCurrent();
    const tabs = (await chrome.tabs.query({})).filter((t) => t.id !== self?.id);
    const hosts = await Promise.all(
      tabs.map((t) => chrome.tabs.sendMessage<unknown, string>(t.id!, { type: "ping" }).catch(() => null)),
    );
    const running = [...new Set(hosts.filter(Boolean))];
    const missing = hosts.filter((h) => h === null).length;
    report(
      "Running in tabs",
      running.length > 0,
      `${running.join(", ") || "no tabs"}${missing ? `. ${missing} other tab${missing > 1 ? "s" : ""} didn't answer. New tabs and chrome:// pages never do, but a chat tab opened before the extension was installed or reloaded needs a refresh` : ""}`,
    );
  }

  async function runTest() {
    if (!test.trim()) return;
    if (looksLikeLaugh(test)) return setResult("Laugh (matched locally)");
    if (!settings.apiKey) return setResult("Not a laugh locally, and no Jev key to ask");
    setResult("Asking Jev…");
    try {
      const p = await jevLaughProbability(test, settings.apiKey);
      setResult(`${p >= settings.threshold ? "Laugh" : "Not a laugh"} (Jev: ${p.toFixed(2)})`);
    } catch (e) {
      setResult(String(e));
    }
  }

  return (
    <main className="settings-page mx-auto flex max-w-md flex-col gap-8 px-4 py-12 text-sm">
      <h1 className="text-xl font-bold normal-case">calLMAOut</h1>

      <section className="flex flex-col gap-2">
        <h2 className="font-bold">Camera</h2>
        <select value={settings.deviceId} onChange={(e) => update({ deviceId: e.target.value })}>
          <option value="">Default</option>
          {cameras.map((c) => (
            <option key={c.deviceId} value={c.deviceId}>
              {c.label || c.deviceId}
            </option>
          ))}
        </select>
        {cameraError ? (
          <p className="text-neutral-500">Camera unavailable: {cameraError}. Allow camera access for this page and reload.</p>
        ) : (
          <div className="relative">
            <video ref={video} autoPlay muted playsInline className="block w-full -scale-x-100" />
            <CameraPreview video={video} threshold={settings.smileThreshold} deviceId={settings.deviceId} />
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-bold">Smile check</h2>
        <h3 className="font-medium">Ready-to-send GIF</h3>
        {settings.enabled && rememberedPhoto ? (
          <figure>
            <img src={rememberedPhoto.dataUrl} alt="Prepared animation with label and stickers" className="w-full" />
            <figcaption className="text-neutral-500">{rememberedPhoto.remembered ? "Remembered smile" : "Latest photo"} · {(rememberedPhoto.ageMs / 1000).toFixed(1)}s ago · {rememberedPhoto.entrance} → {rememberedPhoto.effect} · prepared in {rememberedPhoto.prepareMs}ms</figcaption>
          </figure>
        ) : (
          <p className="text-neutral-500">{settings.enabled ? "Preparing the first GIF…" : "GIF preparation is off."}</p>
        )}
        <label className="flex items-center gap-2">
          Threshold
          <NumberField
            className="w-20"
            min={0}
            max={1}
            value={settings.smileThreshold}
            onCommit={(smileThreshold) => update({ smileThreshold })}
          />
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={settings.rememberSmiles}
            onChange={(e) => update({ rememberSmiles: e.target.checked })}
          />
          Remember smiles
        </label>
        <label className="flex items-center gap-2">
          Remember a smile for
          <NumberField
            className="w-20"
            min={0.5}
            max={30}
            disabled={!settings.rememberSmiles}
            value={settings.smileMemoryMs / 1000}
            onCommit={(seconds) => update({ smileMemoryMs: Math.round(seconds * 1000) })}
          />
          seconds
        </label>

      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-bold">Jev</h2>
        <input
          type="password"
          placeholder="TypeSafe API key"
          value={settings.apiKey}
          onChange={(e) => update({ apiKey: e.target.value.trim() })}
        />
        <label className="flex items-center gap-2">
          Threshold
          <NumberField
            className="w-20"
            min={0}
            max={1}
            value={settings.threshold}
            onCommit={(threshold) => update({ threshold })}
          />
        </label>
        <p className="text-neutral-500">lol, lmao, haha and 😂 💀 🤣 are caught locally. Jev handles the rest.</p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-bold">Sending</h2>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={settings.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
          On
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={settings.autoSend} onChange={(e) => update({ autoSend: e.target.checked })} />
          Send the photo automatically (otherwise it's just attached)
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={settings.skipSmiles} onChange={(e) => update({ skipSmiles: e.target.checked })} />
          Don't send photos counted as smiling
        </label>
        <label className="flex items-center gap-2">
          Wait
          <NumberField
            className="w-20"
            min={0}
            integer
            disabled={!settings.autoSend}
            value={settings.sendDelay}
            onCommit={(sendDelay) => update({ sendDelay })}
          />
          ms before sending the photo
        </label>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-bold">Apology</h2>
        <label className="flex items-center gap-2">
          Strikes before an apology
          <NumberField
            className="w-20"
            min={0}
            integer
            value={settings.apologyStrikes}
            onCommit={(apologyStrikes) => update({ apologyStrikes })}
          />
        </label>
        <p className="text-neutral-500">
          A strike is a laugh sent with a straight face; a real smile resets the count. Reach the limit and you'll have to
          record a 5-second apology video before chatting on. 0 turns it off.
        </p>
        <div className="flex gap-4">
          <span>
            {strikes.apologyDue ? "Apology due" : `${strikes.strikeCount}${settings.apologyStrikes ? ` of ${settings.apologyStrikes}` : ""} strikes`}
          </span>
          <button onClick={() => chrome.storage.local.set({ strikeCount: 0, apologyDue: false })}>Reset</button>
        </div>
        <div className="flex gap-4">
          <span>Microphone: {microphone === "granted" ? "✓ allowed" : microphone || "checking…"}</span>
          {microphone !== "granted" && <button onClick={allowMicrophone}>Allow microphone</button>}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-bold">Troubleshoot</h2>
        <button className="self-start" onClick={runChecks}>
          Run checks
        </button>
        {checks.length > 0 && (
          <ul className="flex flex-col gap-1">
            {checks.map(([name, ok, detail]) => (
              <li key={name}>
                <span className={ok === false ? "font-bold" : ""}>
                  {ok === null ? "–" : ok ? "✓" : "✗"} {name}
                </span>
                {detail && <span className="text-neutral-500"> {detail}</span>}
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-end gap-2">
          {testPhoto && <img src={testPhoto} alt="Test photo" className="w-40" />}
          {testCrop && <img src={testCrop} alt="What the smile model sees" className="w-16 [image-rendering:pixelated]" />}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-bold">Check a message</h2>
        <input
          placeholder="that killed me"
          value={test}
          onChange={(e) => setTest(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && runTest()}
        />
        <button className="self-start" onClick={runTest}>
          Check
        </button>
        {result && <p>{result}</p>}
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex justify-between">
          <h2 className="font-bold">Activity</h2>
          <button onClick={() => chrome.storage.local.set({ log: [] })}>Clear</button>
        </div>
        <p className="text-neutral-500">Send a message in a chat tab and watch each step here. Only kept on this computer.</p>
        {log.length === 0 ? (
          <p className="text-neutral-500">Nothing yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {log
              .slice()
              .reverse()
              .map((entry, i) => (
                <li key={log.length - i}>
                  <span className="text-neutral-500">
                    {new Date(entry.at).toLocaleTimeString()} {entry.where}
                  </span>{" "}
                  {entry.text}
                </li>
              ))}
          </ul>
        )}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Options />);
