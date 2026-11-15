import spec from "./face-spec.json";

export type Settings = {
  enabled: boolean;
  deviceId: string;
  apiKey: string;
  threshold: number;
  autoSend: boolean;
  // Extra wait after the photo is attached, before sending it.
  sendDelay: number;
  // Smile model score at or above which a photo counts as smiling.
  smileThreshold: number;
  // Watch for smiles while typing and send the last one instead of a live photo.
  rememberSmiles: boolean;
  // How long a remembered smile lasts; typing extends it.
  smileMemoryMs: number;
  // Only send photos where you're not smiling.
  skipSmiles: boolean;
  // Neutral-face laughs in a row before an apology video is required; 0 turns it off.
  apologyStrikes: number;
};

export const defaults: Settings = {
  enabled: true,
  deviceId: "",
  apiKey: "",
  threshold: 0.7,
  autoSend: true,
  sendDelay: 200,
  smileThreshold: spec.smileThreshold,
  rememberSmiles: true,
  smileMemoryMs: 3000,
  skipSmiles: false,
  apologyStrikes: 3,
};

export async function getSettings(): Promise<Settings> {
  return { ...defaults, ...(await chrome.storage.local.get(defaults)) } as Settings;
}

export function setSettings(patch: Partial<Settings>) {
  return chrome.storage.local.set(patch);
}
