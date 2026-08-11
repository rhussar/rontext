import type { Theme } from "@/lib/settings";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function resolvesToDark(theme: Theme): boolean {
  return (
    theme === "dark" ||
    (theme === "system" && window.matchMedia(DARK_QUERY).matches)
  );
}

/** Flip the class immediately on click, before the server round-trip lands. */
export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", resolvesToDark(theme));
}

/**
 * Keep "Automatic" honest when the OS flips light/dark mid-session. Toggles the
 * class directly rather than through React state — nothing re-renders, so this
 * stays cheap and can't cause a hydration mismatch.
 */
export function watchSystemTheme(theme: Theme): () => void {
  if (typeof window === "undefined" || theme !== "system") return () => {};
  const mq = window.matchMedia(DARK_QUERY);
  const onChange = () =>
    document.documentElement.classList.toggle("dark", mq.matches);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/**
 * Inlined in <head> so the correct theme is on <html> before first paint. The
 * stored preference is server-rendered into it, so there's no flash and no
 * second source of truth in localStorage.
 */
export function themeInitScript(theme: Theme): string {
  return `(function(){try{var t=${JSON.stringify(theme)};if(t==="dark"||(t==="system"&&window.matchMedia("${DARK_QUERY}").matches)){document.documentElement.classList.add("dark")}}catch(e){}})()`;
}
