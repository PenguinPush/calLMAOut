import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { PHOTO_STYLE_VERSION, smileLabel } from "./lib/photo-overlays";
import type { PhotoAnalysis } from "./lib/messages";
import { useSettings } from "./lib/useSettings";
import "./styles.css";

function Popup() {
  const [settings, update] = useSettings();
  const [photo, setPhoto] = useState("");
  const [oldPhoto, setOldPhoto] = useState(false);
  const [analysis, setAnalysis] = useState<PhotoAnalysis["result"] | null>(null);

  useEffect(() => {
    let active = true;
    let revision = 0;
    const refresh = async () => {
      const current = ++revision;
      const { lastPhoto, lastPhotoId, lastPhotoAnalysis, lastPhotoStyleVersion } = await chrome.storage.local.get(["lastPhoto", "lastPhotoId", "lastPhotoAnalysis", "lastPhotoStyleVersion"]);
      const stored = lastPhotoAnalysis as PhotoAnalysis | null | undefined;
      if (!active || current !== revision) return;
      const obsolete = Boolean(lastPhoto) && lastPhotoStyleVersion !== PHOTO_STYLE_VERSION;
      setOldPhoto(obsolete);
      setPhoto(obsolete ? "" : (lastPhoto as string) ?? "");
      setAnalysis(stored?.photoId === lastPhotoId ? stored?.result ?? null : null);
    };
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && (changes.lastPhoto || changes.lastPhotoId || changes.lastPhotoAnalysis || changes.lastPhotoStyleVersion)) {
        void refresh();
      }
    };
    chrome.storage.onChanged.addListener(onChange);
    void refresh();
    return () => {
      active = false;
      chrome.storage.onChanged.removeListener(onChange);
    };
  }, []);

  const label = analysis ? smileLabel(analysis, settings.smileThreshold) : "Last photo";

  return (
    <main className="flex w-64 flex-col gap-3 p-4 text-sm">
      <h1 className="font-bold">calLMAOut</h1>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={settings.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
        {settings.enabled ? "On" : "Off"}
      </label>
      {!settings.apiKey && <p className="text-neutral-500">No Jev key set, only obvious laughs are caught.</p>}
      {oldPhoto && <p className="text-neutral-500">Take a new photo to see the updated stickers.</p>}
      {photo && (
        <figure className="relative">
          <img src={photo} alt="Last photo" className="w-full" />
          <figcaption aria-live="polite" className="sr-only">
            {label}
          </figcaption>
        </figure>
      )}
      <button className="self-start" onClick={() => chrome.runtime.openOptionsPage()}>
        Settings
      </button>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Popup />);
