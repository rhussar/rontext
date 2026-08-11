"use client";

import { useState, useTransition } from "react";
import { Check, X } from "lucide-react";
import { toast } from "sonner";
import {
  acceptCandidate,
  dismissCandidate,
  restoreCandidate,
  type CandidateItem,
} from "@/lib/actions/candidates";
import { ago, formatPhone } from "@/lib/format";
import { PersonAvatar } from "@/components/person-avatar";
import { PeopleTabs } from "@/components/people-tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const SOURCE_LABEL: Record<CandidateItem["source"], string> = {
  gmail: "Gmail",
  messages: "Messages",
};

/**
 * The gate between a connector and the CRM.
 *
 * Gmail and Messages never create contacts on their own — everyone they find
 * who isn't already known waits here until you say yes. Modelled on
 * cleanup-view.tsx, which is the same interaction: a queue, an editable name,
 * and a two-button decision per row.
 */
export function CandidatesView({ items }: { items: CandidateItem[] }) {
  const [done, setDone] = useState<Set<number>>(new Set());
  const [drafts, setDrafts] = useState<Record<number, string>>(() =>
    Object.fromEntries(items.map((i) => [i.id, i.displayName ?? ""])),
  );
  const [pending, startTransition] = useTransition();

  const remaining = items.filter((i) => !done.has(i.id));

  function accept(item: CandidateItem) {
    const name = (drafts[item.id] ?? "").trim();
    if (!name) return;
    setDone((prev) => new Set(prev).add(item.id));
    startTransition(async () => {
      const res = await acceptCandidate(item.id, name);
      if (!res.ok) {
        // Put it back — the row is still waiting on a decision.
        setDone((prev) => {
          const next = new Set(prev);
          next.delete(item.id);
          return next;
        });
        toast.error(res.error ?? "Could not add contact");
        return;
      }
      toast.success(`Added ${name}`);
    });
  }

  function dismiss(item: CandidateItem) {
    setDone((prev) => new Set(prev).add(item.id));
    startTransition(async () => {
      await dismissCandidate(item.id);
      toast.success(`Dismissed ${label(item)}`, {
        action: {
          label: "Undo",
          onClick: () => {
            restoreCandidate(item.id);
            setDone((prev) => {
              const next = new Set(prev);
              next.delete(item.id);
              return next;
            });
          },
        },
      });
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <PeopleTabs active="discovered" />

      <div className="px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-stone-400">
        {remaining.length === 0
          ? "Nothing to review"
          : `${remaining.length} ${remaining.length === 1 ? "person" : "people"} found in your messages and mail`}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-16">
        {remaining.length === 0 ? (
          <div className="flex flex-col items-center gap-2 pt-16 text-center">
            <p className="text-[15px] font-medium text-stone-600">All reviewed</p>
            <p className="max-w-sm text-[13.5px] text-stone-400">
              People you exchange messages or email with who aren’t in your
              contacts show up here. Nothing is added until you say so.
            </p>
          </div>
        ) : (
          <div className="flex max-w-3xl flex-col gap-1">
            {remaining.map((item) => (
              <div
                key={item.id}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-stone-200 px-3 py-2.5"
              >
                <PersonAvatar
                  name={item.displayName || label(item)}
                  className="size-8"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] text-stone-600">
                    {label(item)}
                  </p>
                  <p className="truncate text-[12px] text-stone-400">
                    {evidence(item)}
                  </p>
                </div>
                <Input
                  value={drafts[item.id] ?? ""}
                  onChange={(e) =>
                    setDrafts((d) => ({ ...d, [item.id]: e.target.value }))
                  }
                  placeholder="Who is this?"
                  className="h-8 w-full min-w-40 flex-1 text-[13.5px] sm:w-48 sm:flex-none"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") accept(item);
                  }}
                />
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-[12.5px]"
                    onClick={() => accept(item)}
                    disabled={pending || !(drafts[item.id] ?? "").trim()}
                  >
                    <Check className="size-3.5" /> Add
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 text-[12.5px] text-stone-500"
                    onClick={() => dismiss(item)}
                    disabled={pending}
                  >
                    <X className="size-3.5" /> Not a person
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function label(item: CandidateItem): string {
  return item.handle.includes("@") ? item.handle : formatPhone(item.handle);
}

/** Why this person is being suggested — the counts are the whole argument. */
function evidence(item: CandidateItem): string {
  const parts = [
    `${SOURCE_LABEL[item.source]} · ${item.messageCount.toLocaleString()} ${
      item.messageCount === 1 ? "message" : "messages"
    }`,
    `${item.sentCount.toLocaleString()} from you`,
  ];
  const last = item.lastAt ? ago(item.lastAt) : null;
  if (last) parts.push(`last ${last}`);
  return parts.join(" · ");
}
