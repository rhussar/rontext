"use client";

import { useEffect } from "react";

/**
 * Opens the <details> element targeted by the URL hash. CSS :target can style
 * a details element but cannot open it, so deep links from the Setup chips
 * (/skills#messages-sync) need this — without it the link scrolls to a
 * collapsed row, which reads as broken.
 */
export function SkillsHashOpener() {
  useEffect(() => {
    const open = () => {
      const el = document.getElementById(window.location.hash.slice(1));
      if (el instanceof HTMLDetailsElement) {
        el.open = true;
        el.scrollIntoView();
      }
    };
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, []);
  return null;
}
