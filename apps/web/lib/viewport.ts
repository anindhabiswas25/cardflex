// Phones always show the app in landscape. When a phone is held upright the
// whole app is turned 90° by CSS (html[data-rot], see app/globals.css), so
// window sizes and touch coordinates are those of the upright screen. Use
// these helpers instead of window.innerWidth/innerHeight and raw clientX/Y.

/** Runs before hydration (inline in app/layout.tsx); keep it ES5, no imports. */
export const ORIENT_SCRIPT = `(function(){var d=document.documentElement;function f(){var s=screen,o=s.orientation&&s.orientation.type,w=innerWidth,h=innerHeight;var phone=matchMedia("(pointer:coarse)").matches&&Math.min(s.width,s.height)<=540;var up=o?o.indexOf("portrait")===0:h>w;phone?d.setAttribute("data-land",""):d.removeAttribute("data-land");phone&&up?d.setAttribute("data-rot",""):d.removeAttribute("data-rot")}f();addEventListener("resize",f);addEventListener("orientationchange",f);screen.orientation&&screen.orientation.addEventListener("change",f)})()`;

/** A phone, either way up: it shows the landscape layout. */
export const isLand = () => typeof document !== "undefined" && document.documentElement.hasAttribute("data-land");
export const isRotated = () => typeof document !== "undefined" && document.documentElement.hasAttribute("data-rot");
/** Width of the app as the player sees it. */
export const viewW = () => (isRotated() ? window.innerHeight : window.innerWidth);
/** Height of the app as the player sees it. */
export const viewH = () => (isRotated() ? window.innerWidth : window.innerHeight);
/** A touch/pointer position in the app's own (landscape) coordinates. */
export function toView(clientX: number, clientY: number) {
  // turned 90° clockwise about the screen's top-right corner: app (x, y) sits at screen (W - y, x)
  return isRotated() ? { x: clientY, y: window.innerWidth - clientX } : { x: clientX, y: clientY };
}
