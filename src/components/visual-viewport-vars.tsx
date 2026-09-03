"use client";

import { useEffect } from "react";

/**
 * Publishes the *visual* viewport as `--vv-height` / `--vv-top` on <html>.
 *
 * iOS does not shrink the layout viewport when the software keyboard opens —
 * only the visual viewport moves — so a `fixed top-1/2` element centres itself
 * against the full screen height and ends up half-buried behind the keyboard.
 * `dvh` does not help: it tracks browser chrome, not the keyboard. Reading
 * visualViewport is the only way to know what is actually on screen.
 *
 * Mounted once in AppShell. Costs nothing while no dialog is open, since
 * nothing else in the tree reads the vars.
 */
export function VisualViewportVars() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const root = document.documentElement;
    let frame = 0;

    // visualViewport.scroll fires per frame during a keyboard-driven scroll,
    // and each write invalidates style for anything reading the vars — so
    // coalesce to one write per frame.
    function sync() {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        root.style.setProperty("--vv-height", `${vv!.height}px`);
        root.style.setProperty("--vv-top", `${vv!.offsetTop}px`);
      });
    }

    sync();
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
      // Back to the 100dvh fallbacks baked into the dialog's calc().
      root.style.removeProperty("--vv-height");
      root.style.removeProperty("--vv-top");
    };
  }, []);

  return null;
}
