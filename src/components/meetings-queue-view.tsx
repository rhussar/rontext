"use client";

import { useState, useTransition } from "react";
import { format } from "date-fns";
import { EyeOff, UserPlus, Video } from "lucide-react";
import { toast } from "sonner";
import {
  assignMeeting,
  setMeetingDismissed,
  unassignMeeting,
  type UnresolvedMeeting,
} from "@/lib/actions/meetings";
import { displayName } from "@/lib/format";
import { MeetingDialog } from "@/components/meeting-dialog";
import { MergeSearchDialog } from "@/components/merge-search-dialog";
import { PeopleTabs } from "@/components/people-tabs";
import { Button } from "@/components/ui/button";

/**
 * Data → Meetings: recorded meetings nobody could be matched to. Each one asks
 * "Who was this meeting with?"; picking a person moves it onto their timeline.
 * "Not in my book" hides it for good (a lecture, a stranger's call).
 */
export function MeetingsQueueView({ items }: { items: UnresolvedMeeting[] }) {
  const [done, setDone] = useState<Set<number>>(new Set());
  const [picking, setPicking] = useState<number | null>(null);
  const [reading, setReading] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();

  const remaining = items.filter((i) => !done.has(i.id));

  function hide(id: number) {
    setDone((prev) => new Set(prev).add(id));
  }
  function unhide(id: number) {
    setDone((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  function assign(meetingId: number, personId: number, name: string) {
    hide(meetingId);
    startTransition(async () => {
      await assignMeeting(meetingId, [personId]);
      toast.success(`Added to ${displayName(name)}'s timeline`, {
        action: {
          label: "Undo",
          onClick: () => {
            unassignMeeting(meetingId, personId);
            unhide(meetingId);
          },
        },
      });
    });
  }

  function dismiss(item: UnresolvedMeeting) {
    hide(item.id);
    startTransition(async () => {
      await setMeetingDismissed(item.id, true);
      toast.success("Hidden", {
        action: {
          label: "Undo",
          onClick: () => {
            setMeetingDismissed(item.id, false);
            unhide(item.id);
          },
        },
      });
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <PeopleTabs active="meetings" />

      <div className="px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {remaining.length === 0
          ? "No meetings to match"
          : `${remaining.length} meeting${remaining.length === 1 ? "" : "s"} without a person`}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-16">
        {remaining.length === 0 ? (
          <div className="flex flex-col items-center gap-2 pt-16 text-center">
            <p className="text-[15px] font-medium text-muted-foreground">All matched</p>
            <p className="max-w-sm text-[13.5px] text-muted-foreground">
              Recorded meetings land on the right person&apos;s timeline
              automatically. When nobody can be matched, they wait here.
            </p>
          </div>
        ) : (
          <div className="flex max-w-3xl flex-col gap-1.5">
            {remaining.map((item) => (
              <div
                key={item.id}
                className="flex flex-col gap-2 rounded-lg border border-border px-3.5 py-3"
              >
                <div className="flex items-start gap-2.5">
                  <Video className="mt-0.5 size-4 shrink-0 text-violet-500" />
                  <div className="min-w-0 flex-1">
                    <button
                      onClick={() => setReading(item.id)}
                      className="block max-w-full truncate text-left text-[14px] font-medium text-foreground hover:underline"
                    >
                      {item.title}
                    </button>
                    <p className="text-[12px] text-muted-foreground">
                      {format(item.startedAt, "EEE, MMM d, yyyy · h:mm a")}
                      {item.attendees.length ? ` · ${item.attendees.join(", ")}` : ""}
                    </p>
                    {item.excerpt ? (
                      <p className="mt-1 line-clamp-2 text-[12.5px] text-muted-foreground">
                        {item.excerpt.replace(/[#*_>`]/g, "").replace(/\s+/g, " ").trim()}
                      </p>
                    ) : null}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 pl-6">
                  <Button
                    size="sm"
                    className="h-8 text-[12.5px]"
                    onClick={() => setPicking(item.id)}
                    disabled={pending}
                  >
                    <UserPlus className="size-3.5" /> Who was this meeting with?
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    title="Hide it — not with anyone in your book"
                    className="h-8 text-[12.5px] text-muted-foreground hover:text-foreground"
                    onClick={() => dismiss(item)}
                    disabled={pending}
                  >
                    <EyeOff className="size-3.5" /> Not in my book
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <MergeSearchDialog
        open={picking !== null}
        onOpenChange={(o) => {
          if (!o) setPicking(null);
        }}
        title="Who was this meeting with?"
        placeholder="Who was this meeting with?"
        onPick={(person) => {
          if (picking !== null) assign(picking, person.id, person.fullName);
        }}
      />
      {reading !== null ? (
        <MeetingDialog
          key={reading}
          meetingId={reading}
          open
          onOpenChange={(o) => {
            if (!o) setReading(null);
          }}
        />
      ) : null}
    </div>
  );
}
