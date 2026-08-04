"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Check, Wand2 } from "lucide-react";
import { toast } from "sonner";
import {
  applyCleanupName,
  type CleanupItem,
} from "@/lib/actions/duplicates";
import { PersonAvatar } from "@/components/person-avatar";
import { PeopleTabs } from "@/components/people-tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function CleanupView({ items }: { items: CleanupItem[] }) {
  const [done, setDone] = useState<Set<number>>(new Set());
  const [drafts, setDrafts] = useState<Record<number, string>>(() =>
    Object.fromEntries(items.map((i) => [i.id, i.suggestion ?? ""])),
  );
  const [pending, startTransition] = useTransition();

  const remaining = items.filter((i) => !done.has(i.id));
  const autoFixable = remaining.filter((i) => (drafts[i.id] ?? "").trim());

  function apply(id: number) {
    const name = (drafts[id] ?? "").trim();
    if (!name) return;
    startTransition(async () => {
      await applyCleanupName(id, name);
      setDone((prev) => new Set(prev).add(id));
    });
  }

  function applyAll() {
    startTransition(async () => {
      for (const item of autoFixable) {
        await applyCleanupName(item.id, (drafts[item.id] ?? "").trim());
      }
      setDone((prev) => {
        const next = new Set(prev);
        autoFixable.forEach((i) => next.add(i.id));
        return next;
      });
      toast.success(`Renamed ${autoFixable.length} contacts`);
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <PeopleTabs active="cleanup">
        {autoFixable.length > 1 ? (
          <Button
            size="sm"
            className="h-7 text-[12.5px]"
            onClick={applyAll}
            disabled={pending}
          >
            <Wand2 className="size-3.5" />
            Apply all {autoFixable.length}
          </Button>
        ) : null}
      </PeopleTabs>

      <div className="px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-stone-400">
        {remaining.length === 0
          ? "Nothing to clean up"
          : `${remaining.length} contact${remaining.length === 1 ? "" : "s"} without a real name`}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-16">
        {remaining.length === 0 ? (
          <div className="flex flex-col items-center gap-2 pt-16 text-center">
            <p className="text-[15px] font-medium text-stone-600">All clean</p>
            <p className="max-w-sm text-[13.5px] text-stone-400">
              Every contact has a real name. Contacts imported with only an email
              address or phone number show up here.
            </p>
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-1">
            {remaining.map((item) => (
              <div
                key={item.id}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-stone-200 px-3 py-2.5"
              >
                <PersonAvatar name={item.fullName} className="size-8" />
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/people?person=${item.id}`}
                    className="block truncate text-[13.5px] text-stone-500 hover:underline"
                  >
                    {item.fullName}
                  </Link>
                  {item.company ? (
                    <p className="truncate text-[12px] text-stone-400">
                      {item.company}
                    </p>
                  ) : null}
                </div>
                <Input
                  value={drafts[item.id] ?? ""}
                  onChange={(e) =>
                    setDrafts((d) => ({ ...d, [item.id]: e.target.value }))
                  }
                  placeholder={
                    item.kind === "phone-name"
                      ? "Who is this?"
                      : "No name could be derived"
                  }
                  className="h-8 w-full min-w-40 flex-1 text-[13.5px] sm:w-48 sm:flex-none"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") apply(item.id);
                  }}
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 shrink-0 text-[12.5px]"
                  onClick={() => apply(item.id)}
                  disabled={pending || !(drafts[item.id] ?? "").trim()}
                >
                  <Check className="size-3.5" /> Rename
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
