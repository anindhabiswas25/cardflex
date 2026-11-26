"use client";
// Touch scrolling while the app is turned 90° (phone held upright, see
// lib/viewport.ts). Browsers pick the pan direction in screen space, so a
// rotated scroller never scrolls by touch on its own; this maps each finger
// move into the app's coordinates and scrolls the nearest scrollable box,
// with a short glide after the finger lifts.
import { useEffect } from "react";
import { isRotated, toView } from "@/lib/viewport";

function scrollable(el: Element, axis: "x" | "y") {
  const cs = getComputedStyle(el);
  const ov = axis === "y" ? cs.overflowY : cs.overflowX;
  if (ov !== "auto" && ov !== "scroll") return false;
  return axis === "y" ? el.scrollHeight > el.clientHeight + 1 : el.scrollWidth > el.clientWidth + 1;
}

function scrollerFor(start: Element | null, axis: "x" | "y"): Element | null {
  for (let el = start; el && el !== document.body; el = el.parentElement) {
    if (scrollable(el, axis)) return el;
    if (el.classList.contains("cf-rot-in")) return null;
  }
  return null;
}

export function RotatedScroll() {
  useEffect(() => {
    let last: { x: number; y: number; t: number } | null = null;
    let target: Element | null = null;
    let axis: "x" | "y" | null = null;
    let v = 0; // px per ms along `axis`
    let glide = 0;

    const stopGlide = () => {
      cancelAnimationFrame(glide);
      glide = 0;
    };
    const by = (el: Element, a: "x" | "y", d: number) => (a === "y" ? (el.scrollTop += d) : (el.scrollLeft += d));

    const onStart = (e: TouchEvent) => {
      stopGlide();
      last = null;
      if (!isRotated() || e.touches.length !== 1) return;
      const el = e.target as Element;
      // sliders and anything that drags by itself keep the raw touch
      if (el.closest?.("input[type=range],[data-own-touch]")) return;
      const p = toView(e.touches[0].clientX, e.touches[0].clientY);
      last = { ...p, t: e.timeStamp };
      target = el;
      axis = null;
      v = 0;
    };
    const onMove = (e: TouchEvent) => {
      if (!last || !target) return;
      const p = toView(e.touches[0].clientX, e.touches[0].clientY);
      const dx = p.x - last.x;
      const dy = p.y - last.y;
      if (!axis) {
        if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
        axis = Math.abs(dy) >= Math.abs(dx) ? "y" : "x";
        const s = scrollerFor(target, axis);
        if (!s) return void (last = null);
        target = s;
      }
      e.preventDefault();
      const d = axis === "y" ? -dy : -dx;
      by(target, axis, d);
      const dt = Math.max(1, e.timeStamp - last.t);
      v = 0.8 * (d / dt) + 0.2 * v;
      last = { ...p, t: e.timeStamp };
    };
    const onEnd = () => {
      if (!last || !target || !axis || Math.abs(v) < 0.05) return void (last = null);
      const el = target;
      const a = axis;
      let t0 = performance.now();
      const step = (t: number) => {
        const dt = t - t0;
        t0 = t;
        by(el, a, v * dt);
        v *= Math.pow(0.95, dt / 16);
        glide = Math.abs(v) > 0.02 ? requestAnimationFrame(step) : 0;
      };
      glide = requestAnimationFrame(step);
      last = null;
    };

    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd);
    document.addEventListener("touchcancel", onEnd);
    return () => {
      stopGlide();
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onEnd);
    };
  }, []);
  return null;
}
