"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { getHomePulse } from "@/lib/actions/contacts";

/**
 * Keeps an open Home tab current without a manual reload.
 *
 * The Chrome extension posts captures to /api/ext/* on the server. Nothing in
 * that path can reach a tab that's already open — revalidatePath() clears the
 * server cache, not the client's — so browsing someone on LinkedIn left Home
 * stale until you hit refresh yourself.
 *
 * Focus is the signal that actually matters here: the whole workflow is "read
 * LinkedIn in one tab, switch back to Rontext". So this checks on every return
 * to the tab, and only otherwise falls back to a slow timer.
 *
 * It polls a cursor rather than refreshing blind: router.refresh() re-runs the
 * entire page (listPeople() is 1,772 rows plus three joins), so firing it on a
 * timer would hammer Neon to redraw an identical feed. getHomePulse() is two
 * max()s, and a refresh only happens when the string moves.
 */
const POLL_MS = 30_000;

export function HomeAutoRefresh({ pulse }: { pulse: string }) {
  const router = useRouter();
  // Seeded from the server render, then advanced on every observed change.
  // A ref, not state: updating it must never itself cause a render.
  const seen = useRef(pulse);

  // The server re-rendered (our own refresh, or a server action elsewhere in
  // the app) — adopt its cursor so the next poll compares against what's
  // actually on screen and can't fire a second, redundant refresh.
  useEffect(() => {
    seen.current = pulse;
  }, [pulse]);

  useEffect(() => {
    let alive = true;
    // Guards against a slow poll landing after a newer one has already
    // refreshed — without it, two in-flight checks can both fire.
    let checking = false;

    async function check() {
      if (!alive || checking || document.visibilityState !== "visible") return;
      checking = true;
      try {
        const next = await getHomePulse();
        if (!alive || next === seen.current) return;
        seen.current = next;
        router.refresh();
      } catch {
        // Offline, or the passcode session expired — the next tick retries.
      } finally {
        checking = false;
      }
    }

    const timer = setInterval(check, POLL_MS);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, [router]);

  return null;
}
