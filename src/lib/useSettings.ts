import { useEffect, useState } from "react";
import { defaults, getSettings, setSettings, type Settings } from "./settings";

export function useSettings() {
  const [settings, set] = useState<Settings>(defaults);

  useEffect(() => {
    getSettings().then(set);
  }, []);

  function update(patch: Partial<Settings>) {
    set((s) => ({ ...s, ...patch }));
    setSettings(patch);
  }

  return [settings, update] as const;
}
