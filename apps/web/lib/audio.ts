"use client";
// One shared Web Audio context for sound effects and music. Browsers keep audio
// muted until the player taps or presses a key, so the context is resumed from
// the first gesture (and again after the phone interrupts it); listeners added
// with onUnlock() run once audio may play.
let ctx: AudioContext | null = null;
let unlocked = false;
const unlockers = new Set<() => void>();

export function audioCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  ctx ??= new AC();
  return ctx;
}

export const isUnlocked = () => unlocked;

/** Runs `f` once audio is unlocked (at once if it already is). Returns an unsubscribe. */
export function onUnlock(f: () => void): () => void {
  if (unlocked) f();
  else unlockers.add(f);
  return () => {
    unlockers.delete(f);
  };
}

let installed = false;
export function installAudioUnlock() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const go = () => {
    const c = audioCtx();
    if (!c || document.hidden) return;
    if (c.state === "running") return markUnlocked();
    void c.resume().then(markUnlocked, () => {});
  };
  for (const e of ["pointerdown", "touchend", "click", "keydown"]) window.addEventListener(e, go, { capture: true, passive: true });
  // a hidden tab is silent; it plays again when the player comes back
  document.addEventListener("visibilitychange", () => {
    const c = ctx;
    if (!c || !unlocked) return;
    if (document.hidden) void c.suspend().catch(() => {});
    else void c.resume().catch(() => {});
  });
}

function markUnlocked() {
  if (unlocked) return;
  unlocked = true;
  const fs = [...unlockers];
  unlockers.clear();
  fs.forEach((f) => f());
}
