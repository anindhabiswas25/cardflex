"use client";
// "Turn your phone" hint: shown when the site opens on a phone held upright
// (html[data-rot], see lib/viewport.ts), where the app is drawn turned 90°.
// It sits outside the turned box, so it reads upright. Gone on a tap, when the
// phone is turned, or after a few seconds; once per browser session.
import { useEffect, useState } from "react";
import { isRotated } from "@/lib/viewport";

const KEY = "cf:rotate-hint";
const SHOW_MS = 4500;

function seen() {
  try {
    return sessionStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}
function markSeen() {
  try {
    sessionStorage.setItem(KEY, "1");
  } catch {}
}

export function RotateHint() {
  const [show, setShow] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!isRotated() || seen()) return;
    markSeen();
    setShow(true);
    const close = () => setLeaving(true);
    const timer = setTimeout(close, SHOW_MS);
    // the player turned the phone (auto-rotate on): the hint has done its job
    const mo = new MutationObserver(() => {
      if (!isRotated()) close();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-rot"] });
    return () => {
      clearTimeout(timer);
      mo.disconnect();
    };
  }, []);

  if (!show) return null;
  return (
    <button
      type="button"
      className={`cf-turn ${leaving ? "is-out" : ""}`}
      onClick={() => setLeaving(true)}
      onAnimationEnd={(e) => e.animationName === "cf-turn-out" && setShow(false)}
      aria-label="Turn your phone sideways to play. Tap to close."
      data-testid="rotate-hint"
    >
      <span className="cf-turn-phone" aria-hidden>
        <i />
      </span>
      <b>Turn your phone</b>
      <small>Card Flex plays sideways</small>
    </button>
  );
}
