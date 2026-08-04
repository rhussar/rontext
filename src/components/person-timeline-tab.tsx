"use client";

import { useState, useTransition } from "react";
import {
  AlarmClock,
  Check,
  Pencil,
  RefreshCw,
  Trash2,
  Undo2,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  addNote,
  deleteNote,
  updateNote,
  type ContactDetail,
} from "@/lib/actions/contacts";
import {
  completeReminder,
  createReminder,
  deleteReminder,
  uncompleteReminder,
} from "@/lib/actions/reminders";
import { buildTimeline, type TimelineItem } from "@/lib/timeline";
import { CHANGE_FIELD_LABELS, noteDate, reminderDateTime } from "@/lib/format";
import type { ContactChange, Note, Reminder } from "@/db/schema";
import { HeadlineDiff } from "@/components/headline-diff";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function PersonTimelineTab({
  detail,
  setDetail,
}: {
  detail: ContactDetail;
  setDetail: (d: ContactDetail) => void;
}) {
  const items = buildTimeline(detail);

  return (
    <div className="flex flex-col gap-3 px-6 pb-24">
      <Composer detail={detail} setDetail={setDetail} />
      {items.map((item) => (
        <FeedRow
          key={item.key}
          item={item}
          detail={detail}
          setDetail={setDetail}
        />
      ))}
      {items.length === 0 ? (
        <p className="py-6 text-center text-[13px] text-stone-400">
          Nothing here yet. Add a note or set a reminder above.
        </p>
      ) : null}
    </div>
  );
}

function FeedRow({
  item,
  detail,
  setDetail,
}: {
  item: TimelineItem;
  detail: ContactDetail;
  setDetail: (d: ContactDetail) => void;
}) {
  switch (item.kind) {
    case "note":
      return (
        <NoteCard
          note={item.note}
          onDeleted={() =>
            setDetail({
              ...detail,
              notes: detail.notes.filter((n) => n.id !== item.note.id),
            })
          }
          onEdited={(body) =>
            setDetail({
              ...detail,
              notes: detail.notes.map((n) =>
                n.id === item.note.id ? { ...n, body } : n,
              ),
            })
          }
        />
      );
    case "reminder":
      return (
        <ReminderCard
          reminder={item.reminder}
          onChanged={(next) =>
            setDetail({
              ...detail,
              reminders: detail.reminders.map((r) =>
                r.id === next.id ? next : r,
              ),
            })
          }
          onDeleted={() =>
            setDetail({
              ...detail,
              reminders: detail.reminders.filter((r) => r.id !== item.reminder.id),
            })
          }
        />
      );
    case "change":
      return <ChangeRow change={item.change} />;
    case "fact":
      return <FactRow label={item.label} date={item.date} />;
  }
}

// ---------- Composer ----------

function Composer({
  detail,
  setDetail,
}: {
  detail: ContactDetail;
  setDetail: (d: ContactDetail) => void;
}) {
  const [mode, setMode] = useState<"note" | "reminder">("note");
  const [draft, setDraft] = useState("");
  const [remindAt, setRemindAt] = useState("");
  const [pending, startTransition] = useTransition();
  const first =
    detail.contact.firstName ?? detail.contact.fullName.split(" ")[0];

  const canSubmit = mode === "note" ? !!draft.trim() : !!remindAt;

  function submit() {
    if (!canSubmit || pending) return;
    if (mode === "note") {
      const body = draft.trim();
      startTransition(async () => {
        const note = await addNote(detail.contact.id, body);
        setDetail({ ...detail, notes: [note, ...detail.notes] });
        setDraft("");
      });
    } else {
      // Convert here, in the browser, so the instant reflects the user's own
      // timezone — a datetime-local value carries none, and parsing it on the
      // server would silently use the server's zone instead.
      const iso = new Date(remindAt).toISOString();
      const body = draft.trim();
      startTransition(async () => {
        const reminder = await createReminder(detail.contact.id, iso, body);
        setDetail({ ...detail, reminders: [reminder, ...detail.reminders] });
        setDraft("");
        setRemindAt("");
        setMode("note");
        toast.success(`Reminder set for ${reminderDateTime(iso)}`);
      });
    }
  }

  return (
    <div className="rounded-lg border border-stone-200 bg-stone-50 transition-colors focus-within:border-stone-300 focus-within:bg-white">
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={
          mode === "reminder"
            ? `What should this reminder say?`
            : `Add a note about ${first}…`
        }
        rows={2}
        className="min-h-0 resize-none border-0 bg-transparent text-[13.5px] shadow-none focus-visible:ring-0"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
        }}
      />
      <div className="flex items-center gap-2 px-2 pb-2">
        <button
          type="button"
          aria-label={mode === "reminder" ? "Switch to note" : "Set a reminder"}
          aria-pressed={mode === "reminder"}
          onClick={() => setMode(mode === "reminder" ? "note" : "reminder")}
          className={cn(
            "flex size-7 items-center justify-center rounded-md transition-colors",
            mode === "reminder"
              ? "bg-amber-100 text-amber-600"
              : "text-stone-400 hover:bg-stone-200/70 hover:text-stone-600",
          )}
        >
          <AlarmClock className="size-4" />
        </button>
        {mode === "reminder" ? (
          <input
            type="datetime-local"
            value={remindAt}
            onChange={(e) => setRemindAt(e.target.value)}
            className="h-7 rounded-md border border-stone-200 bg-white px-2 text-[12.5px] text-stone-700 outline-none focus:border-stone-400"
          />
        ) : null}
        {canSubmit ? (
          <Button
            size="sm"
            className="ml-auto h-7 text-[12.5px]"
            onClick={submit}
            disabled={pending}
          >
            <Check className="size-3.5" />
            {mode === "reminder" ? "Set reminder" : "Save"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// ---------- Feed entries ----------

function ReminderCard({
  reminder,
  onChanged,
  onDeleted,
}: {
  reminder: Reminder;
  onChanged: (r: Reminder) => void;
  onDeleted: () => void;
}) {
  const done = !!reminder.completedAt;

  function toggle() {
    onChanged({ ...reminder, completedAt: done ? null : new Date() });
    (done ? uncompleteReminder(reminder.id) : completeReminder(reminder.id)).catch(
      () => toast.error("Couldn't update that reminder"),
    );
  }

  return (
    <div
      className={cn(
        "group/item relative rounded-lg border px-3 py-2.5",
        done
          ? "border-stone-200 bg-stone-50/60"
          : "border-amber-200 bg-amber-50/60",
      )}
    >
      <div className="flex items-start gap-2">
        <AlarmClock
          className={cn(
            "mt-0.5 size-3.5 shrink-0",
            done ? "text-stone-300" : "text-amber-500",
          )}
        />
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "text-[13.5px] leading-relaxed",
              done ? "text-stone-400 line-through" : "text-stone-700",
            )}
          >
            You set a reminder for {reminderDateTime(reminder.remindAt)}
          </p>
          {reminder.body ? (
            <p
              className={cn(
                "whitespace-pre-wrap pt-1 text-[13.5px] leading-relaxed",
                done ? "text-stone-400 line-through" : "text-stone-600",
              )}
            >
              {reminder.body}
            </p>
          ) : null}
          <p className="pt-1.5 text-[10.5px] uppercase tracking-wide text-stone-400">
            {noteDate(reminder.createdAt)}
            {done ? " · done" : ""}
          </p>
        </div>
      </div>
      <div className="absolute right-1.5 top-1.5 flex gap-0.5 opacity-0 transition-opacity group-hover/item:opacity-100">
        <button
          aria-label={done ? "Mark not done" : "Mark done"}
          className="rounded p-1 text-stone-400 hover:bg-stone-200 hover:text-emerald-600"
          onClick={toggle}
        >
          {done ? <Undo2 className="size-3.5" /> : <Check className="size-3.5" />}
        </button>
        <button
          aria-label="Delete reminder"
          className="rounded p-1 text-stone-400 hover:bg-stone-200 hover:text-red-500"
          onClick={() => {
            if (window.confirm("Delete this reminder?")) {
              deleteReminder(reminder.id);
              onDeleted();
            }
          }}
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

function ChangeRow({ change }: { change: ContactChange }) {
  const label = CHANGE_FIELD_LABELS[change.field] ?? change.field;

  // Headline changes get Mesh's inline diff instead of a "from X to Y" sentence
  if (change.field === "headline") {
    return (
      <div className="flex items-start gap-2 py-1">
        <RefreshCw className="mt-1 size-3 shrink-0 text-sky-400" />
        <div className="min-w-0 flex-1">
          <p className="text-[10.5px] uppercase tracking-wider text-stone-400">
            Headline change
            {change.source === "linkedin" ? " · via LinkedIn" : ""}
          </p>
          <div className="pt-1">
            <HeadlineDiff
              oldValue={change.oldValue}
              newValue={change.newValue}
            />
          </div>
        </div>
        <span className="shrink-0 text-[10.5px] uppercase tracking-wide text-stone-400">
          {noteDate(change.createdAt)}
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2 py-1">
      <RefreshCw className="mt-1 size-3 shrink-0 text-sky-400" />
      <p className="min-w-0 flex-1 text-[13px] text-stone-600">
        {change.field === "connected" ? (
          "Connected on LinkedIn"
        ) : (
          <>
            {label} changed
            {change.oldValue ? (
              <>
                {" from "}
                <span className="text-stone-400">{change.oldValue}</span>
              </>
            ) : null}
            {change.newValue ? (
              <>
                {" to "}
                <span className="font-medium text-stone-700">
                  {change.newValue}
                </span>
              </>
            ) : null}
          </>
        )}
      </p>
      <span className="shrink-0 text-[10.5px] uppercase tracking-wide text-stone-400">
        {noteDate(change.createdAt)}
      </span>
    </div>
  );
}

function FactRow({ label, date }: { label: string; date: string }) {
  return (
    <div className="flex items-baseline gap-2 py-1">
      <span className="size-1.5 shrink-0 translate-y-[-2px] rounded-full bg-orange-300" />
      <span className="text-[13px] text-stone-600">{label}</span>
      <span className="ml-auto shrink-0 text-[10.5px] uppercase tracking-wide text-stone-400">
        {noteDate(date)}
      </span>
    </div>
  );
}

function NoteCard({
  note,
  onDeleted,
  onEdited,
}: {
  note: Note;
  onDeleted: () => void;
  onEdited: (body: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.body);

  if (editing) {
    return (
      <div className="rounded-lg border border-stone-300 bg-white p-1">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          autoFocus
          className="min-h-0 resize-none border-0 text-[13.5px] shadow-none focus-visible:ring-0"
        />
        <div className="flex justify-end gap-1.5 p-1.5">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-[12.5px]"
            onClick={() => {
              setDraft(note.body);
              setEditing(false);
            }}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-7 text-[12.5px]"
            onClick={() => {
              const body = draft.trim();
              if (body && body !== note.body) {
                updateNote(note.id, body);
                onEdited(body);
              }
              setEditing(false);
            }}
          >
            Save
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="group/item relative rounded-lg bg-stone-50 px-3 py-2.5">
      <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-stone-700">
        {note.body}
      </p>
      <div className="flex items-center gap-2 pt-1.5">
        <span className="text-[10.5px] uppercase tracking-wide text-stone-400">
          {noteDate(note.createdAt)}
        </span>
        {note.source === "imported" ? (
          <span className="rounded bg-stone-200/70 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-stone-500">
            Imported from Mesh
          </span>
        ) : null}
      </div>
      <div className="absolute right-1.5 top-1.5 flex gap-0.5 opacity-0 transition-opacity group-hover/item:opacity-100">
        <button
          aria-label="Edit note"
          className="rounded p-1 text-stone-400 hover:bg-stone-200 hover:text-stone-600"
          onClick={() => setEditing(true)}
        >
          <Pencil className="size-3.5" />
        </button>
        <button
          aria-label="Delete note"
          className="rounded p-1 text-stone-400 hover:bg-stone-200 hover:text-red-500"
          onClick={() => {
            if (window.confirm("Delete this note?")) {
              deleteNote(note.id);
              onDeleted();
            }
          }}
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
