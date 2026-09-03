import { Eye } from "lucide-react";
import { DEMO_LINKS } from "@/lib/demo";

/**
 * One line across the top of the content column in demo mode. Sits below the
 * mobile header (which owns the safe-area inset) so it needs none of its own.
 */
export function DemoBanner() {
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-center gap-x-2 gap-y-0.5 border-b border-violet-200 bg-violet-50 px-3 py-1.5 text-center text-[12.5px] text-violet-900 dark:border-violet-900/60 dark:bg-violet-950/40 dark:text-violet-200">
      <Eye className="size-3.5 shrink-0" aria-hidden />
      <span>
        <span className="font-semibold">Demo workspace.</span> Every person here
        is fictional, and the app is read-only.
      </span>
      <a
        href={DEMO_LINKS.github}
        target="_blank"
        rel="noreferrer"
        className="font-medium underline decoration-violet-400/60 underline-offset-2 hover:decoration-violet-500"
      >
        Source on GitHub
      </a>
    </div>
  );
}
