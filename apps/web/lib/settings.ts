"use client";
// Player preferences, saved in this browser. Shared live between components.
import { useEffect, useState } from "react";

export type Settings = { sound: boolean; animations: boolean; turnAlert: boolean };
const DEFAULTS: Settings = { sound: true, animations: true, turnAlert: true };
const KEY = "cf:settings";
const listeners = new Set<(s: Settings) => void>();

export function readSettings(): Settings {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") }; } catch { return DEFAULTS; }
}

function apply(s: Settings) {
  if (typeof document !== "undefined") document.documentElement.dataset.motion = s.animations ? "on" : "off";
}

export function writeSettings(patch: Partial<Settings>) {
  const s = { ...readSettings(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
  apply(s);
  listeners.forEach((l) => l(s));
}

export function useSettings(): [Settings, (p: Partial<Settings>) => void] {
  const [s, setS] = useState<Settings>(DEFAULTS);
  useEffect(() => {
    const cur = readSettings();
    setS(cur);
    apply(cur);
    listeners.add(setS);
    return () => { listeners.delete(setS); };
  }, []);
  return [s, writeSettings];
}
