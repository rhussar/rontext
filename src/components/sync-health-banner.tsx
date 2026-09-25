"use client";

import { AlertTriangle } from "lucide-react";
import { format, parseISO } from "date-fns";
import { useShell } from "@/components/app-shell";
import type { SyncState } from "@/lib/sync-health";

/**
 * Top of Home, only when a tracked sync (Messages, WhatsApp, Gmail, Google
 * Calendar) hasn't succeeded within SYNC_MAX_AGE_HOURS. Silence here means
 * all four are landing; the detail per run lives in Settings → Connections.
 */
export function SyncHealthBanner({ syncs }: { syncs: SyncState[] }) {
  const { openConnections, demo } = useShell();
  const broken = syncs.filter((s) => !s.ok);
  if (!broken.length || demo) return null;

  return (
    <section className="mx-5 rounded-lg border border-red-200 bg-red-50/70 px-3.5 py-3 dark:border-red-900/50 dark:bg-red-950/30">
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-600 dark:text-red-400" />
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-medium text-red-800 dark:text-red-200">
            {broken.length === 1
              ? `${broken[0].label} isn't syncing`
              : `${broken.length} syncs aren't landing`}
          </p>
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {broken.map((s) => (
              <li key={s.job} className="text-[12.5px] leading-snug text-red-900/80 dark:text-red-200/80">
                <span className="font-medium">{s.label}</span> {s.headline}
                {s.lastOkAt ? ` (last worked ${format(parseISO(s.lastOkAt), "MMM d")})` : ""}.
                {s.latestError ? (
                  <span className="block text-red-900/60 dark:text-red-200/60">Latest run: {s.latestError}</span>
                ) : null}
                <span className="block text-red-900/60 dark:text-red-200/60">Fix: {s.fix}.</span>
              </li>
            ))}
          </ul>
        </div>
        <button
          type="button"
          onClick={openConnections}
          className="shrink-0 rounded-md border border-red-200 bg-background px-2.5 py-1 text-[12px] font-medium text-red-700 transition-colors hover:bg-red-50 dark:border-red-900/60 dark:text-red-300 dark:hover:bg-red-950/50"
        >
          Connections
        </button>
      </div>
    </section>
  );
}
