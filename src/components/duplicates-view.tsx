"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Check, X } from "lucide-react";
import { toast } from "sonner";
import { dismissDuplicate, mergeContacts } from "@/lib/actions/duplicates";
import type { DupCandidate, DupPair } from "@/lib/duplicates";
import { PersonAvatar } from "@/components/person-avatar";
import { PeopleTabs } from "@/components/people-tabs";
import { Button } from "@/components/ui/button";

export function DuplicatesView({ pairs }: { pairs: DupPair[] }) {
  const [resolved, setResolved] = useState<Set<string>>(new Set());
  const remaining = pairs.filter((p) => !resolved.has(`${p.a.id}-${p.b.id}`));

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <PeopleTabs active="duplicates" />

      <div className="flex flex-wrap items-baseline gap-x-2.5 px-5 py-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-stone-400">
          {remaining.length === 0
            ? "No duplicates to review"
            : `${remaining.length} possible duplicate${remaining.length === 1 ? "" : "s"}`}
        </span>
        {remaining.length > 0 ? (
          // Said once here rather than on every card: it changes whether you're
          // willing to click Keep, so it's worth stating — but only once.
          <span className="text-[12px] text-stone-400">
            Keeping one merges the other into it and archives it — nothing is
            deleted.
          </span>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-16">
        {remaining.length === 0 ? (
          <div className="flex flex-col items-center gap-2 pt-16 text-center">
            <p className="text-[15px] font-medium text-stone-600">
              Nothing to merge
            </p>
            <p className="max-w-sm text-[13.5px] text-stone-400">
              Every pair has been merged or marked as different people. New
              suggestions appear here after an import or sync.
            </p>
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-3">
            {remaining.map((pair) => (
              <PairCard
                key={`${pair.a.id}-${pair.b.id}`}
                pair={pair}
                onResolved={() =>
                  setResolved((prev) =>
                    new Set(prev).add(`${pair.a.id}-${pair.b.id}`),
                  )
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PairCard({
  pair,
  onResolved,
}: {
  pair: DupPair;
  onResolved: () => void;
}) {
  const [pending, startTransition] = useTransition();

  function merge(keeper: DupCandidate, loser: DupCandidate) {
    startTransition(async () => {
      await mergeContacts(keeper.id, loser.id);
      toast.success(`Merged into ${keeper.fullName}`);
      onResolved();
    });
  }

  function dismiss() {
    startTransition(async () => {
      await dismissDuplicate(pair.a.id, pair.b.id);
      toast.success("Marked as different people");
      onResolved();
    });
  }

  return (
    // pt-9 reserves the button's row once for the whole box, so a stacked
    // single-column layout doesn't repeat the gap above each half.
    <div className="relative overflow-hidden rounded-xl border border-stone-200 pt-9">
      {/* Third choice, kept out of the way of the two Keep buttons */}
      <Button
        variant="ghost"
        size="sm"
        className="absolute right-1.5 top-1.5 z-10 h-7 text-[12.5px] text-stone-400 hover:text-stone-700"
        onClick={dismiss}
        disabled={pending}
      >
        <X className="size-3.5" /> Not duplicates
      </Button>

      {/* grid-cols-1 is explicit for its minmax(0,1fr): an implicit track sizes
          to min-content, and `truncate` sets nowrap, so the card would grow to
          the full untruncated name width and overflow on narrow screens. */}
      <div className="grid grid-cols-1 gap-px bg-stone-100 sm:grid-cols-2">
        <SideCard
          person={pair.a}
          disabled={pending}
          onKeep={() => merge(pair.a, pair.b)}
        />
        <SideCard
          person={pair.b}
          disabled={pending}
          onKeep={() => merge(pair.b, pair.a)}
        />
      </div>
    </div>
  );
}

function SideCard({
  person,
  onKeep,
  disabled,
}: {
  person: DupCandidate;
  onKeep: () => void;
  disabled: boolean;
}) {
  // The only text kept: what actually distinguishes the two records.
  const details = [
    person.emails[0],
    person.phoneNumbers[0],
    person.linkedinUrl ? "LinkedIn" : null,
    person.noteCount > 0
      ? `${person.noteCount} note${person.noteCount === 1 ? "" : "s"}`
      : null,
  ].filter(Boolean) as string[];

  return (
    <div className="flex min-w-0 flex-col gap-2.5 bg-white p-4">
      <div className="flex items-center gap-2.5">
        <PersonAvatar
          name={person.fullName}
          photoSrc={person.hasPhoto ? `/api/photos/${person.id}` : null}
          className="size-9"
        />
        <div className="min-w-0 flex-1">
          <Link
            href={`/people?person=${person.id}`}
            className="block truncate text-[14.5px] font-semibold text-stone-800 hover:underline"
          >
            {person.fullName}
          </Link>
          <p className="truncate text-[12px] text-stone-400">
            {[person.title, person.company].filter(Boolean).join(" · ") ||
              "No company on file"}
          </p>
        </div>
      </div>

      {details.length > 0 ? (
        <p className="truncate text-[12px] text-stone-500">
          {details.join(" · ")}
        </p>
      ) : null}

      <Button
        size="sm"
        variant="outline"
        className="mt-auto h-8 text-[12.5px]"
        onClick={onKeep}
        disabled={disabled}
      >
        <Check className="size-3.5" />
        Keep this one
      </Button>
    </div>
  );
}
