"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { HomePersonLink } from "@/components/home-shell";
import { toast } from "sonner";
import { markDraftSent, type OpenDraft } from "@/lib/actions/drafts";
import { PersonAvatar } from "@/components/person-avatar";
import { copyText } from "@/lib/clipboard-text";
import { CHANNEL_LABELS, draftClipboardText } from "@/lib/outreach";

export function HomeDrafts({ drafts }: { drafts: OpenDraft[] }) {
  const [items, setItems] = useState(drafts);

  function markSent(id: number) {
    setItems((prev) => prev.filter((d) => d.id !== id));
    markDraftSent(id).catch(() => toast.error("Couldn't mark that draft sent"));
  }

  async function copy(d: OpenDraft) {
    if (await copyText(draftClipboardText(d))) {
      toast.success(`Copied your ${CHANNEL_LABELS[d.channel].toLowerCase()} to ${d.contactName}`);
    } else {
      toast.error("Couldn't copy");
    }
  }

  if (items.length === 0) {
    return (
      <p className="px-5 py-1.5 text-[13.5px] text-muted-foreground">
        No drafts. Open someone and use the pen icon to write one.
      </p>
    );
  }

  return (
    <div>
      {items.map((d) => (
        <div
          key={d.id}
          className="flex items-center gap-3 px-5 py-2.5 transition-colors hover:bg-muted/50"
        >
          <HomePersonLink
            personId={d.contactId}
            className="flex min-w-0 flex-1 items-center gap-3"
          >
            <PersonAvatar
              name={d.contactName}
              photoSrc={d.hasPhoto ? `/api/photos/${d.contactId}` : null}
              className="size-8"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14.5px] font-medium text-foreground">
                {d.contactName}
              </p>
              <p className="truncate text-[12px] text-muted-foreground">
                {d.subject || d.body ||
                  [d.title, d.company].filter(Boolean).join(" · ") ||
                  "Draft"}
              </p>
            </div>
          </HomePersonLink>
          <div className="flex shrink-0 items-center gap-2">
            <span className="rounded-full bg-violet-100 dark:bg-violet-950/50 px-2 py-0.5 text-[11px] font-semibold text-violet-700 dark:text-violet-300">
              {CHANNEL_LABELS[d.channel]}
            </span>
            <button
              onClick={() => copy(d)}
              aria-label={`Copy draft for ${d.contactName}`}
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-muted-foreground"
            >
              <Copy className="size-4" />
            </button>
            <button
              onClick={() => markSent(d.id)}
              aria-label={`Mark draft for ${d.contactName} sent`}
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-emerald-50 dark:hover:bg-emerald-950/40 hover:text-emerald-600 dark:hover:text-emerald-400"
            >
              <Check className="size-4" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
