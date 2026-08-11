"use client";

import { useEffect, useState, useTransition } from "react";
import {
  AlarmClock,
  Check,
  ChevronDown,
  Copy,
  Mail,
  MessageSquare,
  Pencil,
  PenLine,
  RefreshCw,
  Trash2,
  Undo2,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useShell } from "@/components/app-shell";
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
import {
  createDraft,
  deleteDraft,
  markDraftSent,
  unmarkDraftSent,
  updateDraft,
} from "@/lib/actions/drafts";
import {
  buildHandoff,
  channelReady,
  CHANNEL_LABELS,
  CHANNEL_PHRASES,
  CHANNEL_SENT_LABELS,
  defaultChannel,
  draftClipboardText,
  outreachTarget,
  type OutreachTarget,
} from "@/lib/outreach";
import { copyText } from "@/lib/clipboard-text";
import { buildTimeline, type TimelineItem } from "@/lib/timeline";
import {
  CHANGE_FIELD_LABELS,
  noteDate,
  reminderDateTime,
  roleLine,
} from "@/lib/format";
import {
  DRAFT_CHANNELS,
  type ContactChange,
  type Draft,
  type DraftChannel,
  type Note,
  type Reminder,
} from "@/db/schema";
import { HeadlineDiff } from "@/components/headline-diff";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
          Nothing here yet. Add a note, set a reminder, or write a message above.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The explicit return type is load-bearing: without it TypeScript infers
 * `… | undefined` for a switch with no default, so forgetting a case for a new
 * TimelineItem kind renders nothing and raises no error at all.
 */
function FeedRow({
  item,
  detail,
  setDetail,
}: {
  item: TimelineItem;
  detail: ContactDetail;
  setDetail: (d: ContactDetail) => void;
}): React.ReactElement {
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
    case "draft":
      return (
        <DraftCard
          draft={item.draft}
          target={outreachTarget(detail.contact)}
          onChanged={(next) =>
            setDetail({
              ...detail,
              drafts: detail.drafts.map((d) => (d.id === next.id ? next : d)),
            })
          }
          onDeleted={() =>
            setDetail({
              ...detail,
              drafts: detail.drafts.filter((d) => d.id !== item.draft.id),
            })
          }
        />
      );
    case "change":
      return (
        <ChangeRow
          change={item.change}
          previousRole={roleLine(detail.contact.title, detail.contact.company)}
        />
      );
    case "fact":
      return <FactRow label={item.label} date={item.date} />;
  }
}

// ---------- Composer ----------

/**
 * The configured time today, or tomorrow if that's already passed. Formatted
 * for `datetime-local`, which wants local time with no zone suffix.
 */
function nextDefaultReminder(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const at = new Date();
  at.setHours(h || 10, m || 0, 0, 0);
  if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function Composer({
  detail,
  setDetail,
}: {
  detail: ContactDetail;
  setDetail: (d: ContactDetail) => void;
}) {
  const { defaultReminderTime } = useShell();
  const [mode, setMode] = useState<"note" | "reminder" | "draft">("note");
  const [text, setText] = useState("");
  const [remindAt, setRemindAt] = useState("");
  const target = outreachTarget(detail.contact);
  const [channel, setChannel] = useState<DraftChannel>(() =>
    defaultChannel(target),
  );
  const [subject, setSubject] = useState("");
  const [pending, startTransition] = useTransition();
  const first =
    detail.contact.firstName ?? detail.contact.fullName.split(" ")[0];

  const canSubmit = mode === "reminder" ? !!remindAt : !!text.trim();

  function submit() {
    if (!canSubmit || pending) return;
    const body = text.trim();
    if (mode === "note") {
      startTransition(async () => {
        const note = await addNote(detail.contact.id, body);
        setDetail({ ...detail, notes: [note, ...detail.notes] });
        setText("");
      });
    } else if (mode === "draft") {
      startTransition(async () => {
        const draft = await createDraft(
          detail.contact.id,
          channel,
          body,
          subject,
        );
        setDetail({ ...detail, drafts: [draft, ...detail.drafts] });
        setText("");
        setSubject("");
        setMode("note");
        toast.success(`${CHANNEL_LABELS[channel]} draft saved`);
      });
    } else {
      // Convert here, in the browser, so the instant reflects the user's own
      // timezone — a datetime-local value carries none, and parsing it on the
      // server would silently use the server's zone instead.
      const iso = new Date(remindAt).toISOString();
      startTransition(async () => {
        const reminder = await createReminder(detail.contact.id, iso, body);
        setDetail({ ...detail, reminders: [reminder, ...detail.reminders] });
        setText("");
        setRemindAt("");
        setMode("note");
        toast.success(`Reminder set for ${reminderDateTime(iso)}`);
      });
    }
  }

  const placeholder =
    mode === "reminder"
      ? "What should this reminder say?"
      : mode === "draft"
        ? `Draft ${CHANNEL_PHRASES[channel]} to ${first}…`
        : `Add a note about ${first}…`;

  return (
    <div className="rounded-lg border border-stone-200 bg-stone-50 transition-colors focus-within:border-stone-300 focus-within:bg-white">
      {mode === "draft" && channel === "email" ? (
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Subject"
          className="w-full border-b border-stone-200 bg-transparent px-3 pb-1.5 pt-2.5 text-[13.5px] font-medium text-stone-700 outline-none placeholder:font-normal placeholder:text-stone-400"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
          }}
        />
      ) : null}
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        rows={2}
        className="min-h-0 resize-none border-0 bg-transparent text-[13.5px] shadow-none focus-visible:ring-0"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
        }}
      />
      <div className="flex items-center gap-2 px-2 pb-2 pt-1.5">
        <button
          type="button"
          aria-label={mode === "reminder" ? "Switch to note" : "Set a reminder"}
          aria-pressed={mode === "reminder"}
          onClick={() => {
            const next = mode === "reminder" ? "note" : "reminder";
            // Opening the picker empty means every reminder needs the time typed
            // out; seed it from the configured default instead.
            if (next === "reminder" && !remindAt) {
              setRemindAt(nextDefaultReminder(defaultReminderTime));
            }
            setMode(next);
          }}
          className={cn(
            "flex size-7 items-center justify-center rounded-md transition-colors",
            mode === "reminder"
              ? "bg-amber-100 text-amber-600"
              : "text-stone-400 hover:bg-stone-200/70 hover:text-stone-600",
          )}
        >
          <AlarmClock className="size-4" />
        </button>
        <button
          type="button"
          aria-label={mode === "draft" ? "Switch to note" : "Write a message"}
          aria-pressed={mode === "draft"}
          onClick={() => setMode(mode === "draft" ? "note" : "draft")}
          className={cn(
            "flex size-7 items-center justify-center rounded-md transition-colors",
            mode === "draft"
              ? "bg-violet-100 text-violet-600"
              : "text-stone-400 hover:bg-stone-200/70 hover:text-stone-600",
          )}
        >
          <PenLine className="size-4" />
        </button>
        {mode === "reminder" ? (
          <input
            type="datetime-local"
            value={remindAt}
            onChange={(e) => setRemindAt(e.target.value)}
            className="h-7 rounded-md border border-stone-200 bg-white px-2 text-[12.5px] text-stone-700 outline-none focus:border-stone-400"
          />
        ) : null}
        {mode === "draft" ? (
          <ChannelPicker value={channel} onChange={setChannel} target={target} />
        ) : null}
        {canSubmit ? (
          <Button
            size="sm"
            className="ml-auto h-7 text-[12.5px]"
            onClick={submit}
            disabled={pending}
          >
            <Check className="size-3.5" />
            {mode === "reminder"
              ? "Set reminder"
              : mode === "draft"
                ? "Save draft"
                : "Save"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * lucide-react ships no LinkedIn glyph (brand icons were removed), which is why
 * person-detail.tsx hand-rolls this same "in" square for its quick action.
 */
function ChannelIcon({
  channel,
  className,
}: {
  channel: DraftChannel;
  className?: string;
}) {
  if (channel === "email") return <Mail className={cn("size-3.5", className)} />;
  if (channel === "sms")
    return <MessageSquare className={cn("size-3.5", className)} />;
  return (
    <span className="flex size-3.5 items-center justify-center rounded-[3px] bg-[#0a66c2] text-[7px] font-bold text-white">
      in
    </span>
  );
}

/**
 * Three segmented buttons rather than a Select — it's one div, it matches the
 * icon-button idiom next to it, and a popover for three options is overkill.
 * Channels the contact has no handle for stay selectable (you may want to draft
 * before you have the address); the card's send button is what reports that.
 */
/** Selected-state color per channel — email reads as blue, text as green,
 * LinkedIn keeps the brand-neutral violet the picker always used. */
const CHANNEL_ACTIVE_CLASS: Record<DraftChannel, string> = {
  email: "bg-blue-100 text-blue-600",
  sms: "bg-emerald-100 text-emerald-600",
  linkedin: "bg-violet-100 text-violet-600",
};

function ChannelPicker({
  value,
  onChange,
  target,
}: {
  value: DraftChannel;
  onChange: (c: DraftChannel) => void;
  target: OutreachTarget;
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-md border border-stone-200 bg-white p-0.5">
      {DRAFT_CHANNELS.map((c) => (
        <button
          key={c}
          type="button"
          aria-label={CHANNEL_LABELS[c]}
          aria-pressed={value === c}
          title={
            channelReady(c, target)
              ? CHANNEL_LABELS[c]
              : `${CHANNEL_LABELS[c]} — nothing on file to send to`
          }
          onClick={() => onChange(c)}
          className={cn(
            "flex size-6 items-center justify-center rounded transition-colors",
            value === c
              ? CHANNEL_ACTIVE_CLASS[c]
              : "text-stone-400 hover:bg-stone-100 hover:text-stone-600",
            !channelReady(c, target) && value !== c && "opacity-50",
          )}
        >
          <ChannelIcon channel={c} />
        </button>
      ))}
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
        <ConfirmDeleteButton
          label="Delete reminder"
          onConfirm={() => {
            deleteReminder(reminder.id);
            onDeleted();
          }}
        />
      </div>
    </div>
  );
}

/** Draft-card tint per channel — echoes each channel's own identity (LinkedIn
 * blue, email as a highlighter yellow, text/SMS green) rather than the single
 * violet every draft used to get regardless of channel. */
const CHANNEL_CARD_CLASS: Record<
  DraftChannel,
  { icon: string; border: string; bg: string; editBorder: string }
> = {
  email: {
    icon: "text-amber-500",
    border: "border-amber-200",
    bg: "bg-amber-50/60",
    editBorder: "border-amber-300",
  },
  linkedin: {
    icon: "text-blue-500",
    border: "border-blue-200",
    bg: "bg-blue-50/60",
    editBorder: "border-blue-300",
  },
  sms: {
    icon: "text-emerald-500",
    border: "border-emerald-200",
    bg: "bg-emerald-50/60",
    editBorder: "border-emerald-300",
  },
};

function DraftCard({
  draft,
  target,
  onChanged,
  onDeleted,
}: {
  draft: Draft;
  target: OutreachTarget;
  onChanged: (d: Draft) => void;
  onDeleted: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(draft.body);
  const [subject, setSubject] = useState(draft.subject ?? "");
  const [channel, setChannel] = useState<DraftChannel>(draft.channel);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const sent = !!draft.sentAt;
  const handoff = buildHandoff(target, draft);
  // One line of what went out, so the collapsed row is still worth reading.
  const preview = (draft.subject || draft.body).split("\n")[0].trim();

  function toggleSent() {
    onChanged({ ...draft, sentAt: sent ? null : new Date() });
    (sent ? unmarkDraftSent(draft.id) : markDraftSent(draft.id)).catch(() =>
      toast.error("Couldn't update that draft"),
    );
  }

  async function copyOnly() {
    if (await copyText(draftClipboardText(draft))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } else {
      toast.error("Couldn't copy");
    }
  }

  async function send() {
    // Copy first, always — then prefilling is a bonus rather than the only
    // path, and LinkedIn (which can't be prefilled) stops being a special case.
    await copyText(handoff.copy);
    if (!handoff.url) {
      toast.error(handoff.reason!);
      return;
    }
    if (handoff.scheme === "web") {
      window.open(handoff.url, "_blank", "noopener");
    } else {
      // mailto:/sms: through window.open strands an about:blank tab.
      window.location.href = handoff.url;
    }
    toast.success(
      handoff.needsPaste ? "Copied — paste it in" : "Copied and opened",
      sent
        ? undefined
        : { action: { label: "Mark sent", onClick: toggleSent } },
    );
  }

  if (editing) {
    return (
      <div
        className={cn(
          "rounded-lg border bg-white p-1",
          CHANNEL_CARD_CLASS[channel].editBorder,
        )}
      >
        <div className="px-2 pt-1.5">
          <ChannelPicker value={channel} onChange={setChannel} target={target} />
        </div>
        {channel === "email" ? (
          <Input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject"
            className="mt-1.5 border-0 text-[13.5px] font-medium shadow-none focus-visible:ring-0"
          />
        ) : null}
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={4}
          autoFocus
          className="min-h-0 resize-none border-0 text-[13.5px] shadow-none focus-visible:ring-0"
        />
        <div className="flex justify-end gap-1.5 p-1.5">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-[12.5px]"
            onClick={() => {
              setBody(draft.body);
              setSubject(draft.subject ?? "");
              setChannel(draft.channel);
              setEditing(false);
            }}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-7 text-[12.5px]"
            onClick={() => {
              const next = body.trim();
              const nextSubject = channel === "email" ? subject.trim() : "";
              updateDraft(draft.id, {
                channel,
                body: next,
                subject: nextSubject,
              }).catch(() => toast.error("Couldn't save that draft"));
              onChanged({
                ...draft,
                channel,
                body: next,
                subject: nextSubject || null,
              });
              setEditing(false);
            }}
          >
            Save
          </Button>
        </div>
      </div>
    );
  }

  // Once it's out the door a draft stops being a to-do and becomes a record, so
  // it collapses to a one-line entry like the other timeline events. Expand it
  // to see what actually went out.
  if (sent) {
    return (
      <div className="group/item">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full items-start gap-2 rounded py-1 text-left transition-colors hover:bg-stone-50"
        >
          <ChannelIcon
            channel={draft.channel}
            className="mt-0.5 shrink-0 text-stone-400"
          />
          <span className="min-w-0 flex-1 text-[13px] text-stone-600">
            {CHANNEL_SENT_LABELS[draft.channel]}
            {preview ? (
              <span className="text-stone-400"> · {preview}</span>
            ) : null}
          </span>
          <ChevronDown
            className={cn(
              "mt-0.5 size-3 shrink-0 text-stone-300 transition-transform",
              expanded && "rotate-180",
            )}
          />
          <span className="shrink-0 text-[10.5px] uppercase tracking-wide text-stone-400">
            {noteDate(draft.sentAt!)}
          </span>
        </button>

        {expanded ? (
          <div className="ml-5 mt-1 rounded-lg bg-stone-50 px-3 py-2.5">
            {draft.subject ? (
              <p className="pb-1 text-[13.5px] font-medium text-stone-700">
                {draft.subject}
              </p>
            ) : null}
            <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-stone-600">
              {draft.body}
            </p>
            <div className="flex flex-wrap items-center gap-1.5 pt-2">
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-[12.5px]"
                onClick={copyOnly}
              >
                {copied ? (
                  <Check className="size-3.5 text-emerald-600" />
                ) : (
                  <Copy className="size-3.5" />
                )}
                {copied ? "Copied" : "Copy"}
              </Button>
              <button
                aria-label="Mark not sent"
                title="Mark not sent"
                className="rounded p-1 text-stone-400 hover:bg-stone-200 hover:text-stone-600"
                onClick={toggleSent}
              >
                <Undo2 className="size-3.5" />
              </button>
              <ConfirmDeleteButton
                label="Delete draft"
                onConfirm={() => {
                  deleteDraft(draft.id);
                  onDeleted();
                }}
              />
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group/item relative rounded-lg border px-3 py-2.5",
        CHANNEL_CARD_CLASS[draft.channel].border,
        CHANNEL_CARD_CLASS[draft.channel].bg,
      )}
    >
      <div className="flex items-start gap-2">
        <ChannelIcon
          channel={draft.channel}
          className={cn("mt-0.5 shrink-0", CHANNEL_CARD_CLASS[draft.channel].icon)}
        />
        <div className="min-w-0 flex-1">
          <p className="text-[10.5px] uppercase tracking-wider text-stone-400">
            {CHANNEL_LABELS[draft.channel]} draft
          </p>
          {draft.subject ? (
            <p className="pt-1 text-[13.5px] font-medium text-stone-700">
              {draft.subject}
            </p>
          ) : null}
          <p className="whitespace-pre-wrap pt-1 text-[13.5px] leading-relaxed text-stone-600">
            {draft.body}
          </p>

          {/* Always visible, never hover-gated — these are the point of the feature. */}
          <div className="flex flex-wrap items-center gap-1.5 pt-2">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[12.5px]"
              onClick={send}
              disabled={!handoff.url}
              title={handoff.reason ?? undefined}
            >
              <ChannelIcon channel={draft.channel} />
              {handoff.label}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-[12.5px]"
              onClick={copyOnly}
            >
              {copied ? (
                <Check className="size-3.5 text-emerald-600" />
              ) : (
                <Copy className="size-3.5" />
              )}
              {copied ? "Copied" : "Copy"}
            </Button>
            {/* A title attribute is invisible on touch, so say it out loud too. */}
            {handoff.reason ? (
              <span className="text-[11px] text-stone-400">
                {handoff.reason}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      <div className="absolute right-1.5 top-1.5 flex gap-0.5 opacity-0 transition-opacity group-hover/item:opacity-100">
        <button
          aria-label="Edit draft"
          className="rounded p-1 text-stone-400 hover:bg-stone-200 hover:text-stone-600"
          onClick={() => setEditing(true)}
        >
          <Pencil className="size-3.5" />
        </button>
        <button
          aria-label="Mark sent"
          title="Mark sent"
          className="rounded p-1 text-stone-400 hover:bg-stone-200 hover:text-emerald-600"
          onClick={toggleSent}
        >
          <Check className="size-3.5" />
        </button>
        <ConfirmDeleteButton
          label="Delete draft"
          onConfirm={() => {
            deleteDraft(draft.id);
            onDeleted();
          }}
        />
      </div>
    </div>
  );
}

function ChangeRow({
  change,
  previousRole,
}: {
  change: ContactChange;
  previousRole: string | null;
}) {
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
              previousRole={previousRole}
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

/**
 * Two-step delete. Replaces window.confirm(), which silently returns false in
 * embedded/in-app browsers — the button looked dead because the dialog never
 * appeared.
 */
function ConfirmDeleteButton({
  label,
  onConfirm,
}: {
  label: string;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(timer);
  }, [armed]);

  if (armed) {
    return (
      <button
        aria-label={`Confirm ${label.toLowerCase()}`}
        className="rounded bg-red-50 px-1.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-red-600 hover:bg-red-100"
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
      >
        Delete?
      </button>
    );
  }

  return (
    <button
      aria-label={label}
      className="rounded p-1 text-stone-400 hover:bg-stone-200 hover:text-red-500"
      onClick={() => setArmed(true)}
    >
      <Trash2 className="size-3.5" />
    </button>
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
        <ConfirmDeleteButton
          label="Delete note"
          onConfirm={() => {
            deleteNote(note.id);
            onDeleted();
          }}
        />
      </div>
    </div>
  );
}
