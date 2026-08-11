"use client";

/**
 * Some contexts (older browsers, permissions-locked iframes) reject the async
 * Clipboard API outright. Fall back to the old select-and-execCommand trick,
 * which asks for no permission at all.
 */
export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const el = document.createElement("textarea");
    el.value = value;
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  }
}
