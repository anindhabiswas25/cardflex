"use client";
// A soft tap sound on every button, link and switch press (lib/sound.ts, "tap"),
// when the Sound setting is on. One listener for the whole app.
import { useEffect } from "react";
import { play } from "@/lib/sound";

const CLICKABLE = 'button, a[href], summary, [role=button], [role=tab], [role=switch], [role=menuitem], input:is([type=checkbox],[type=radio],[type=button],[type=submit]), select';

export function TapSound() {
  useEffect(() => {
    const on = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const el = (e.target as Element | null)?.closest?.(CLICKABLE);
      if (!el || el.matches(":disabled,[aria-disabled=true]")) return;
      play("tap");
    };
    window.addEventListener("pointerdown", on, { capture: true, passive: true });
    return () => window.removeEventListener("pointerdown", on, { capture: true });
  }, []);
  return null;
}
