"use client";

import { useState } from "react";
import Link from "next/link";
import { Check, Copy } from "lucide-react";
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
      <p className="px-5 py-1.5 text-[13.5px] text-stone-400">
        No drafts. Open someone and use the pen icon to write one.
      </p>
    );
  }

  return (
    <div>
      {items.map((d) => (
        <div
          key={d.id}
          className="flex items-center gap-3 px-5 py-2.5 transition-colors hover:bg-stone-50"
        >
          <Link
            href={`/people?person=${d.contactId}`}
            className="flex min-w-0 flex-1 items-center gap-3"
          >
            <PersonAvatar
              name={d.contactName}
              photoSrc={d.hasPhoto ? `/api/photos/${d.contactId}` : null}
              className="size-8"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14.5px] font-medium text-stone-800">
                {d.contactName}
              </p>
              <p className="truncate text-[12px] text-stone-400">
                {d.subject || d.body ||
                  [d.title, d.company].filter(Boolean).join(" · ") ||
                  "Draft"}
              </p>
            </div>
          </Link>
          <div className="flex shrink-0 items-center gap-2">
            <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-semibold text-violet-700">
              {CHANNEL_LABELS[d.channel]}
            </span>
            <button
              onClick={() => copy(d)}
              aria-label={`Copy draft for ${d.contactName}`}
              className="rounded-md p-1.5 text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600"
            >
              <Copy className="size-4" />
            </button>
            <button
              onClick={() => markSent(d.id)}
              aria-label={`Mark draft for ${d.contactName} sent`}
              className="rounded-md p-1.5 text-stone-400 transition-colors hover:bg-emerald-50 hover:text-emerald-600"
            >
              <Check className="size-4" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
