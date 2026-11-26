"use client";
// Player preferences, saved in this browser. Shared live between components.
import { useEffect, useState } from "react";

// Card animations are always on (the OS "reduce motion" setting is still respected).
export type Settings = { sound: boolean; music: boolean; turnAlert: boolean };
const DEFAULTS: Settings = { sound: true, music: true, turnAlert: true };
const KEY = "cf:settings";
const listeners = new Set<(s: Settings) => void>();

export function readSettings(): Settings {
  try {
    const { sound, music, turnAlert } = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
    return { sound, music, turnAlert };
  } catch {
    return DEFAULTS;
  }
}

// An older version could switch card animations off; clear that leftover flag.
function apply() {
  if (typeof document !== "undefined") delete document.documentElement.dataset.motion;
}

export function writeSettings(patch: Partial<Settings>) {
  const s = { ...readSettings(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
  apply();
  listeners.forEach((l) => l(s));
}

/** Called with the new settings whenever they change. Returns an unsubscribe. */
export function subscribeSettings(f: (s: Settings) => void): () => void {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
}

export function useSettings(): [Settings, (p: Partial<Settings>) => void] {
  const [s, setS] = useState<Settings>(DEFAULTS);
  useEffect(() => {
    const cur = readSettings();
    setS(cur);
    apply();
    listeners.add(setS);
    return () => { listeners.delete(setS); };
  }, []);
  return [s, writeSettings];
}
