import { APOLOGY_MS } from "./apology-recorder-constants";
import { analyzeUkulele } from "./ukulele-audio";

const cached = new Map<number, ReturnType<typeof decodeMusic>>();

async function decodeMusic(rate: number) {
  const response = await fetch(chrome.runtime.getURL("ukelele.mp3"));
  if (!response.ok) throw new Error(`Ukulele backing track unavailable (${response.status})`);
  // Offline decoding resamples to the microphone rate without playing music into it.
  const context = new OfflineAudioContext(1, 1, rate);
  const decoded = await context.decodeAudioData(await response.arrayBuffer());
  const samples = Math.min(decoded.length, Math.ceil(rate * APOLOGY_MS / 1000));
  const backing = new Float32Array(samples);
  for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
    const values = decoded.getChannelData(channel);
    for (let i = 0; i < samples; i++) backing[i] += values[i] / decoded.numberOfChannels;
  }
  return { backing, notes: analyzeUkulele(backing, rate) };
}

export function loadApologyMusic(rate = 48000) {
  const existing = cached.get(rate);
  if (existing) return existing;
  const loading = decodeMusic(rate);
  // Normally 48kHz; retain at most one alternate microphone rate.
  if (cached.size >= 2) cached.delete(cached.keys().next().value!);
  cached.set(rate, loading);
  loading.catch(() => { if (cached.get(rate) === loading) cached.delete(rate); });
  return loading;
}
