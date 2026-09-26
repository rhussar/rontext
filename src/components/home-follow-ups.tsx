"use client";

import { useState } from "react";
import { format, parseISO } from "date-fns";
import {
  Check,
  ListTodo,
  EllipsisVertical,
  ExternalLink,
  Mail,
} from "lucide-react";
import { toast } from "sonner";
import { HomePersonLink } from "@/components/home-shell";
import { PersonAvatar } from "@/components/person-avatar";
import { SectionHeader, ViewMoreFooter } from "@/components/home-expand";
import { useShell } from "@/components/app-shell";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  completeFollowUp,
  dismissFollowUp,
  reopenFollowUp,
  snoozeFollowUp,
} from "@/lib/actions/follow-ups";
import type { HomeFollowUp } from "@/lib/follow-ups";
import type { FollowUpKind, FollowUpSource } from "@/db/schema";

/** Rows before the section folds behind View more. Gmail's to-dos show three; a CRM owes more people. */
const COLLAPSED_ROWS = 5;

/** Whose move it is, said from your side. */
const KIND_LABEL: Record<FollowUpKind, string> = {
  promised: "You promised",
  asked: "They asked",
  waiting: "Nudge them",
};

const SOURCE_LABEL: Record<FollowUpSource, string> = {
  email: "Gmail",
  meeting: "Meeting",
  imessage: "Texts",
};

/** 8am local on the day `days` from now — snoozes land at the start of a day, not mid-meeting. */
function morningIn(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(8, 0, 0, 0);
  return d.toISOString();
}

/** Days until next Monday (1-7), so "Next week" from a Monday is a week, not today. */
function daysToMonday(): number {
  const dow = new Date().getDay();
  return ((8 - dow) % 7) || 7;
}

function dueLabel(f: HomeFollowUp): string {
  return f.overdue ? "Overdue" : `Due ${format(parseISO(f.dueOn!), "MMM d")}`;
}

export function HomeFollowUps({ followUps }: { followUps: HomeFollowUp[] }) {
  const [items, setItems] = useState(followUps);
  const [expanded, setExpanded] = useState(false);
  const { demo } = useShell();

  // Optimistic: the row leaves at once and comes back if the write fails or
  // the owner hits Undo. Undo restores it at its old position.
  function act(
    f: HomeFollowUp,
    run: () => Promise<void>,
    message: string,
    undoable: boolean,
  ) {
    const index = items.findIndex((x) => x.id === f.id);
    const restore = () =>
      setItems((prev) =>
        prev.some((x) => x.id === f.id)
          ? prev
          : [...prev.slice(0, index), f, ...prev.slice(index)],
      );
    setItems((prev) => prev.filter((x) => x.id !== f.id));
    run().then(
      () =>
        toast.success(message, {
          action: undoable
            ? {
                label: "Undo",
                onClick: () => {
                  restore();
                  reopenFollowUp(f.id).catch(() =>
                    toast.error("Couldn't undo that"),
                  );
                },
              }
            : undefined,
        }),
      () => {
        restore();
        toast.error("Couldn't update that follow-up");
      },
    );
  }

  const header = <SectionHeader icon={<ListTodo />} label="Follow-ups" />;

  if (items.length === 0) {
    return (
      <section>
        {header}
          <p className="px-5 py-1.5 text-[13.5px] text-muted-foreground">
            Nothing owed. The follow-ups agent reads your email for promises and
            asks, and lists them here.
          </p>
      </section>
    );
  }

  // The toggle sits after the first rows and the rest open *below* it, so it
  // never moves: View more and View less are the same spot on screen.
  const row = (f: (typeof items)[number]) => {
    const who = (
      <>
        <PersonAvatar
          name={f.personName}
          photoSrc={
            f.contactId && f.hasPhoto ? `/api/photos/${f.contactId}` : null
          }
          className="mt-0.5 size-8"
        />
        <div className="min-w-0 flex-1">
          {/* The badge sits inline so a wrapped title flows around it
              instead of the badge claiming a column on a phone. */}
          <p className="text-[14.5px] font-semibold leading-snug text-foreground">
            {f.title}
            {f.isNew ? (
              <span className="ml-2 inline-block rounded-full bg-blue-600 px-1.5 py-px align-[1px] text-[10.5px] font-semibold text-white dark:bg-blue-500">
                New
              </span>
            ) : null}
            {f.hasDraft ? (
              <span
                className="ml-2 inline-block rounded-full bg-violet-100 px-1.5 py-px align-[1px] text-[10.5px] font-semibold text-violet-700 dark:bg-violet-950/50 dark:text-violet-300"
                title="A reply is waiting in Drafts"
              >
                Draft ready
              </span>
            ) : null}
          </p>
          {f.detail ? (
            <p className="line-clamp-2 pt-0.5 text-[13px] leading-snug text-muted-foreground">
              {f.detail}
            </p>
          ) : null}
          <p
            className="pt-1 text-[10.5px] uppercase tracking-wider text-muted-foreground"
            suppressHydrationWarning
          >
            {/* On a phone the due date moves down here, off the action row. */}
            {f.dueOn ? (
              <span
                className={cn(
                  "font-semibold sm:hidden",
                  f.overdue && "text-rose-600 dark:text-rose-400",
                )}
              >
                {dueLabel(f)} ·{" "}
              </span>
            ) : null}
            {[
              KIND_LABEL[f.kind],
              f.contactId ? null : f.personName,
              SOURCE_LABEL[f.source],
              format(parseISO(f.lastMessageAt), "MMM d"),
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
      </>
    );
    return (
      <div
        key={f.id}
        className="flex items-start gap-3 px-5 py-3 transition-colors hover:bg-muted/50"
      >
        {f.contactId ? (
          <HomePersonLink
            personId={f.contactId}
            className="flex min-w-0 flex-1 items-start gap-3"
          >
            {who}
          </HomePersonLink>
        ) : (
          <div className="flex min-w-0 flex-1 items-start gap-3">{who}</div>
        )}

        <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
          {f.dueOn ? (
            <span
              className={
                f.overdue
                  ? "hidden rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-semibold text-rose-700 sm:inline dark:bg-rose-950/50 dark:text-rose-300"
                  : "hidden text-[11.5px] text-muted-foreground sm:inline"
              }
            >
              {dueLabel(f)}
            </span>
          ) : null}
          {f.link ? (
            <a
              href={f.link}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open the ${SOURCE_LABEL[f.source]} thread`}
              className="flex items-center gap-1.5 rounded-full bg-blue-50 px-2.5 py-1 text-[12.5px] font-medium text-blue-700 transition-colors hover:bg-blue-100 dark:bg-blue-950/50 dark:text-blue-300 dark:hover:bg-blue-900/50"
            >
              {f.source === "email" ? (
                <Mail className="size-3.5" />
              ) : (
                <ExternalLink className="size-3.5" />
              )}
              <span className="hidden sm:inline">View</span>
            </a>
          ) : null}
          {!demo ? (
            <>
              <button
                onClick={() =>
                  act(f, () => completeFollowUp(f.id), "Marked done", true)
                }
                aria-label={`Mark "${f.title}" done`}
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-emerald-50 hover:text-emerald-600 dark:hover:bg-emerald-950/40 dark:hover:text-emerald-400"
              >
                <Check className="size-4" />
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <button
                      aria-label={`More for "${f.title}"`}
                      className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <EllipsisVertical className="size-4" />
                    </button>
                  }
                />
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuItem
                    onClick={() =>
                      act(
                        f,
                        () => snoozeFollowUp(f.id, morningIn(1)),
                        "Snoozed until tomorrow",
                        true,
                      )
                    }
                  >
                    Snooze until tomorrow
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() =>
                      act(
                        f,
                        () => snoozeFollowUp(f.id, morningIn(daysToMonday())),
                        "Snoozed until Monday",
                        true,
                      )
                    }
                  >
                    Snooze until Monday
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() =>
                      act(
                        f,
                        () => dismissFollowUp(f.id),
                        "Dismissed. It won't come back from a re-scan",
                        true,
                      )
                    }
                  >
                    Not a follow-up
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <section>
      {header}
      <div>{items.slice(0, COLLAPSED_ROWS).map(row)}</div>
      {items.length > COLLAPSED_ROWS ? (
        <ViewMoreFooter
          expanded={expanded}
          hidden={items.length - COLLAPSED_ROWS}
          onClick={() => setExpanded((e) => !e)}
        />
      ) : null}
      {expanded ? <div>{items.slice(COLLAPSED_ROWS).map(row)}</div> : null}
    </section>
  );
}
