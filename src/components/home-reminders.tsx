"use client";

import { useState } from "react";
import Link from "next/link";
import { Check } from "lucide-react";
import { toast } from "sonner";
import {
  completeReminder,
  type UpcomingReminder,
} from "@/lib/actions/reminders";
import { PersonAvatar } from "@/components/person-avatar";
import { reminderDateTime } from "@/lib/format";

export function HomeReminders({
  reminders,
}: {
  reminders: UpcomingReminder[];
}) {
  const [items, setItems] = useState(reminders);

  function markDone(id: number) {
    setItems((prev) => prev.filter((r) => r.id !== id));
    completeReminder(id).catch(() =>
      toast.error("Couldn't mark that reminder done"),
    );
  }

  if (items.length === 0) {
    return (
      <p className="px-5 py-1.5 text-[13.5px] text-muted-foreground">
        No reminders. Open someone and use the alarm icon to set one.
      </p>
    );
  }

  return (
    <div>
      {items.map((r) => (
        <div
          key={r.id}
          className="flex items-center gap-3 px-5 py-2.5 transition-colors hover:bg-muted/50"
        >
          <Link
            href={`/people?person=${r.contactId}`}
            className="flex min-w-0 flex-1 items-center gap-3"
          >
            <PersonAvatar
              name={r.contactName}
              photoSrc={r.hasPhoto ? `/api/photos/${r.contactId}` : null}
              className="size-8"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14.5px] font-medium text-foreground">
                {r.contactName}
              </p>
              <p className="truncate text-[12px] text-muted-foreground">
                {r.body ||
                  [r.title, r.company].filter(Boolean).join(" · ") ||
                  "Reminder"}
              </p>
            </div>
          </Link>
          <div className="flex shrink-0 items-center gap-2">
            {r.overdue ? (
              <span className="rounded-full bg-rose-100 dark:bg-rose-950/50 px-2 py-0.5 text-[11px] font-semibold text-rose-700 dark:text-rose-300">
                Overdue
              </span>
            ) : null}
            <span className="hidden text-[11.5px] text-muted-foreground sm:inline">
              {reminderDateTime(r.remindAt)}
            </span>
            <button
              onClick={() => markDone(r.id)}
              aria-label={`Mark reminder for ${r.contactName} done`}
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
