import { Eye } from "lucide-react";
import { DEMO_LINKS } from "@/lib/demo";

/**
 * The demo notice: a solid stripe across the very top of the app, above the
 * sidebar and content alike, so every screenshot and every screen carries it.
 * Solid violet in both themes on purpose — it should read as a label on the
 * app, not as part of the app. It pads for the status-bar inset itself since
 * it is now the topmost element on a phone.
 */
export function DemoBanner() {
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-violet-600 px-4 pb-2.5 pt-[calc(0.625rem+env(safe-area-inset-top))] text-center text-[14px] leading-snug text-white dark:bg-violet-700">
      {/* Hidden on phones: centred flex-wrap would park it on a line of its own. */}
      <Eye className="hidden size-4 shrink-0 sm:block" aria-hidden />
      <span>
        <span className="font-semibold">This is a demo.</span> Every person,
        company and message here is fictional, and nothing can be edited.
      </span>
      <a
        href={DEMO_LINKS.github}
        target="_blank"
        rel="noreferrer"
        className="font-semibold underline decoration-white/50 underline-offset-2 hover:decoration-white"
      >
        Source on GitHub
      </a>
    </div>
  );
}
