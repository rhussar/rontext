"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  ArrowLeft,
  Check,
  ExternalLink,
  Mail,
  MoreHorizontal,
  Pencil,
  Phone,
  Plus,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  addNote,
  addToGroup,
  deleteNote,
  getContactDetail,
  removeFromGroup,
  setArchived,
  setStarred,
  updateContact,
  updateNote,
  type ContactDetail,
  type ContactPatch,
  type PersonRow,
} from "@/lib/actions/contacts";
import {
  ago,
  CHANGE_FIELD_LABELS,
  linkedinSlug,
  noteDate,
  reachOutSentence,
} from "@/lib/format";
import type { GroupWithCount } from "@/components/app-shell";
import { PersonAvatar } from "@/components/person-avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="pb-2 text-[11px] font-semibold uppercase tracking-wider text-stone-400">
      {children}
    </p>
  );
}

export function PersonDetail({
  personId,
  row,
  groups,
  onClose,
  mobile = false,
}: {
  personId: number;
  row: PersonRow | null;
  groups: GroupWithCount[];
  onClose: () => void;
  mobile?: boolean;
}) {
  const [detail, setDetail] = useState<ContactDetail | null>(null);
  const [, startTransition] = useTransition();

  useEffect(() => {
    let alive = true;
    getContactDetail(personId).then((d) => {
      if (alive) setDetail(d);
    });
    return () => {
      alive = false;
    };
  }, [personId]);

  const c = detail?.contact;
  const displayName = c?.fullName ?? row?.fullName ?? "";

  function toggleStar() {
    if (!detail) return;
    const next = !detail.contact.starred;
    setDetail({ ...detail, contact: { ...detail.contact, starred: next } });
    startTransition(() => setStarred(personId, next));
  }

  function archive(archived: boolean) {
    startTransition(async () => {
      await setArchived(personId, archived);
      toast.success(archived ? `${displayName} archived` : `${displayName} restored`);
      if (archived) onClose();
    });
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto overscroll-contain">
      {/* Top bar */}
      <div className="sticky top-0 z-10 flex items-center gap-1 bg-white/90 px-3 py-2 backdrop-blur">
        {mobile ? (
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Back">
            <ArrowLeft className="size-5" />
          </Button>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleStar}
            aria-label="Star"
            className="text-stone-400"
          >
            <Star
              className={cn(
                "size-[18px]",
                c?.starred && "fill-amber-400 text-amber-400",
              )}
            />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-stone-400"
                  aria-label="More options"
                >
                  <MoreHorizontal className="size-[18px]" />
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              {c?.linkedinUrl ? (
                <DropdownMenuItem
                  onClick={() => window.open(c.linkedinUrl!, "_blank")}
                >
                  <ExternalLink className="size-4" /> Open LinkedIn
                </DropdownMenuItem>
              ) : null}
              {c?.meshUrl ? (
                <DropdownMenuItem onClick={() => window.open(c.meshUrl!, "_blank")}>
                  <ExternalLink className="size-4" /> Open in Mesh
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              {c?.archivedAt ? (
                <DropdownMenuItem onClick={() => archive(false)}>
                  Restore from archive
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={() => archive(true)}>
                  Archive
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          {!mobile ? (
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              aria-label="Close"
              className="text-stone-400"
            >
              <X className="size-[18px]" />
            </Button>
          ) : null}
        </div>
      </div>

      {/* Header */}
      <div className="flex flex-col items-center gap-2 px-6 pb-5 pt-2 text-center">
        <PersonAvatar
          name={displayName || "?"}
          photoSrc={detail?.hasPhoto ? `/api/photos/${personId}` : null}
          className="size-24"
          textClass="text-[28px]"
        />
        <h2 className="pt-1 text-[21px] font-semibold leading-tight text-stone-900">
          {displayName}
        </h2>
        {c?.title || c?.company ? (
          <p className="text-[13.5px] text-stone-500">
            {[c?.title, c?.company].filter(Boolean).join(" · ")}
          </p>
        ) : null}
        {c?.location ? (
          <p className="text-[12px] uppercase tracking-wide text-stone-400">
            {c.location}
          </p>
        ) : null}

        {/* Quick actions */}
        {c ? (
          <div className="flex items-center gap-2 pt-2">
            {c.linkedinUrl ? (
              <QuickAction
                label="LinkedIn"
                onClick={() => window.open(c.linkedinUrl!, "_blank")}
              >
                <span className="flex size-4 items-center justify-center rounded-[3px] bg-[#0a66c2] text-[9px] font-bold text-white">
                  in
                </span>
              </QuickAction>
            ) : null}
            {c.emails[0] ? (
              <QuickAction
                label="Email"
                onClick={() => window.open(`mailto:${c.emails[0]}`)}
              >
                <Mail className="size-4" />
              </QuickAction>
            ) : null}
            {c.phoneNumbers[0] ? (
              <QuickAction
                label="Call"
                onClick={() => window.open(`tel:${c.phoneNumbers[0].replace(/[^+\d]/g, "")}`)}
              >
                <Phone className="size-4" />
              </QuickAction>
            ) : null}
          </div>
        ) : null}
      </div>

      {!detail ? (
        <div className="flex flex-col gap-3 px-6">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
        <DetailBody
          detail={detail}
          setDetail={setDetail}
          groups={groups}
        />
      )}
    </div>
  );
}

function QuickAction({
  children,
  label,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className="flex size-9 items-center justify-center rounded-full bg-stone-100 text-stone-600 transition-colors hover:bg-stone-200"
    >
      {children}
    </button>
  );
}

function DetailBody({
  detail,
  setDetail,
  groups,
}: {
  detail: ContactDetail;
  setDetail: (d: ContactDetail) => void;
  groups: GroupWithCount[];
}) {
  const c = detail.contact;
  const sentence = reachOutSentence({
    ...c,
    interactionSources: c.interactionSources,
  });

  const timeline: { label: string; date: string; detail?: string }[] = [];
  if (c.lastInteractionDate)
    timeline.push({ label: "Last interaction", date: c.lastInteractionDate });
  if (
    c.lastLinkedinMessageDate &&
    c.lastLinkedinMessageDate !== c.lastInteractionDate
  )
    timeline.push({
      label: "Last LinkedIn message",
      date: c.lastLinkedinMessageDate,
    });
  if (c.linkedinConnectedOn)
    timeline.push({ label: "Connected on LinkedIn", date: c.linkedinConnectedOn });
  if (c.firstInteractionDate)
    timeline.push({ label: "First interaction", date: c.firstInteractionDate });
  for (const ch of detail.changes) {
    if (ch.field === "connected") continue; // linkedinConnectedOn already covers it
    timeline.push({
      label: `${CHANGE_FIELD_LABELS[ch.field] ?? ch.field} changed`,
      date: new Date(ch.createdAt).toISOString().slice(0, 10),
      detail: `${ch.oldValue ?? "—"} → ${ch.newValue ?? "—"}`,
    });
  }
  timeline.sort((a, b) => b.date.localeCompare(a.date));

  return (
    <div className="flex flex-col gap-6 px-6 pb-24">
      {/* Notes */}
      <section>
        <SectionLabel>Notes</SectionLabel>
        <NotesSection detail={detail} setDetail={setDetail} />
      </section>

      {/* Groups */}
      <section>
        <SectionLabel>Groups</SectionLabel>
        <GroupChips detail={detail} setDetail={setDetail} groups={groups} />
      </section>

      {/* Timeline */}
      {timeline.length > 0 ? (
        <section>
          <SectionLabel>Timeline</SectionLabel>
          <div className="flex flex-col gap-2.5">
            {timeline.map((t, i) => (
              <div key={i} className="flex flex-col gap-0.5">
                <div className="flex items-baseline gap-2">
                  <span className="size-1.5 shrink-0 translate-y-[-2px] rounded-full bg-orange-300" />
                  <span className="text-[13.5px] text-stone-700">{t.label}</span>
                  <span className="ml-auto text-[11px] uppercase text-stone-400">
                    {noteDate(t.date)}
                  </span>
                </div>
                {t.detail ? (
                  <p className="truncate pl-3.5 text-[12px] text-stone-400">
                    {t.detail}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* Sources */}
      {sentence || c.interactionSources.length > 0 ? (
        <section>
          <SectionLabel>Sources</SectionLabel>
          {sentence ? (
            <p className="pb-2 text-[13.5px] leading-relaxed text-stone-600">
              {sentence}
            </p>
          ) : null}
          {c.linkedinUrl ? (
            <a
              href={c.linkedinUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 py-1 text-[13.5px] text-stone-700 underline decoration-stone-300 underline-offset-2 hover:decoration-stone-500"
            >
              <span className="flex size-[15px] items-center justify-center rounded-[3px] bg-[#0a66c2] text-[8.5px] font-bold text-white">
                in
              </span>
              {linkedinSlug(c.linkedinUrl)}
            </a>
          ) : null}
          {c.interactionSources.length > 0 ? (
            <p className="pt-1 text-[12px] text-stone-400">
              Known from: {c.interactionSources.join(", ")}
            </p>
          ) : null}
        </section>
      ) : null}

      {/* Details (editable) */}
      <section>
        <SectionLabel>Details</SectionLabel>
        <div className="flex flex-col">
          <EditableField
            label="First name"
            value={c.firstName ?? ""}
            onSave={(v) => save({ firstName: v || null })}
          />
          <EditableField
            label="Last name"
            value={c.lastName ?? ""}
            onSave={(v) => save({ lastName: v || null })}
          />
          <EditableField
            label="Company"
            value={c.company ?? ""}
            onSave={(v) => save({ company: v || null })}
          />
          <EditableField
            label="Title"
            value={c.title ?? ""}
            onSave={(v) => save({ title: v || null })}
          />
          <EditableField
            label="Headline"
            value={c.headline ?? ""}
            onSave={(v) => save({ headline: v || null })}
          />
          <EditableField
            label="Emails"
            value={c.emails.join("; ")}
            placeholder="one@a.com; two@b.com"
            onSave={(v) =>
              save({
                emails: v.split(/[,;]/).map((s) => s.trim()).filter(Boolean),
              })
            }
          />
          <EditableField
            label="Phones"
            value={c.phoneNumbers.join("; ")}
            onSave={(v) =>
              save({
                phoneNumbers: v.split(/[,;]/).map((s) => s.trim()).filter(Boolean),
              })
            }
          />
          <EditableField
            label="Birthday"
            type="date"
            value={c.birthday ?? ""}
            onSave={(v) => save({ birthday: v || null })}
          />
          <EditableField
            label="Location"
            value={c.location ?? ""}
            onSave={(v) => save({ location: v || null })}
          />
          <EditableField
            label="LinkedIn"
            value={c.linkedinUrl ?? ""}
            onSave={(v) => save({ linkedinUrl: v || null })}
          />
        </div>
      </section>

      {/* Properties */}
      <section>
        <SectionLabel>Properties</SectionLabel>
        <div className="flex flex-col gap-1.5 text-[12px]">
          <PropRow label="Created" value={ago(c.createdAt) ?? ""} />
          <PropRow label="Last updated" value={ago(c.updatedAt) ?? ""} />
          {c.source === "import" ? <PropRow label="Source" value="CSV import" /> : null}
          {c.source === "linkedin" ? <PropRow label="Source" value="LinkedIn" /> : null}
          {c.lastScrapedAt ? (
            <PropRow label="Last synced" value={ago(c.lastScrapedAt) ?? ""} />
          ) : null}
        </div>
      </section>
    </div>
  );

  function save(patch: ContactPatch) {
    const merged = { ...detail.contact, ...patch } as ContactDetail["contact"];
    if ("firstName" in patch || "lastName" in patch) {
      const joined = [merged.firstName, merged.lastName].filter(Boolean).join(" ");
      if (joined) merged.fullName = joined;
    }
    setDetail({ ...detail, contact: merged });
    updateContact(c.id, patch).catch(() => toast.error("Couldn't save"));
  }
}

function PropRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="uppercase tracking-wide text-stone-400">{label}</span>
      <span className="uppercase tracking-wide text-stone-500">{value}</span>
    </div>
  );
}

// ---------- Editable field ----------

function EditableField({
  label,
  value,
  onSave,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string;
  onSave: (value: string) => void;
  type?: string;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(value);
  const lastCommitted = useRef(value);

  useEffect(() => {
    setDraft(value);
    lastCommitted.current = value;
  }, [value]);

  function commit() {
    if (draft.trim() === lastCommitted.current.trim()) return;
    lastCommitted.current = draft;
    onSave(draft.trim());
  }

  return (
    <div className="flex items-center gap-3 border-b border-stone-100 py-1.5 last:border-0">
      <span className="w-24 shrink-0 text-[12px] text-stone-400">{label}</span>
      <input
        type={type}
        value={draft}
        placeholder={placeholder ?? "—"}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-[13.5px] text-stone-800 outline-none transition-colors placeholder:text-stone-300 hover:bg-stone-50 focus:border-stone-300 focus:bg-white"
      />
    </div>
  );
}

// ---------- Groups ----------

function GroupChips({
  detail,
  setDetail,
  groups,
}: {
  detail: ContactDetail;
  setDetail: (d: ContactDetail) => void;
  groups: GroupWithCount[];
}) {
  const memberOf = groups.filter((g) => detail.groupIds.includes(g.id));
  const available = groups.filter((g) => !detail.groupIds.includes(g.id));
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {memberOf.map((g) => (
        <span
          key={g.id}
          className="group/chip flex items-center gap-1.5 rounded-md border border-stone-200 bg-stone-50 px-2 py-1 text-[12px] font-medium uppercase tracking-wide text-stone-600"
        >
          <span
            className="size-1.5 rounded-full"
            style={{ backgroundColor: g.color }}
          />
          {g.name}
          <button
            aria-label={`Remove from ${g.name}`}
            className="text-stone-300 hover:text-stone-500"
            onClick={() => {
              setDetail({
                ...detail,
                groupIds: detail.groupIds.filter((id) => id !== g.id),
              });
              removeFromGroup(detail.contact.id, g.id);
            }}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <button className="flex items-center gap-1 rounded-md border border-dashed border-stone-300 px-2 py-1 text-[12px] font-medium text-stone-400 hover:border-stone-400 hover:text-stone-600">
              <Plus className="size-3" /> Add
            </button>
          }
        />
        <PopoverContent align="start" className="w-48 p-1">
          {available.length === 0 ? (
            <p className="px-2 py-1.5 text-[12.5px] text-stone-400">
              No more groups. Create one from the sidebar.
            </p>
          ) : (
            available.map((g) => (
              <button
                key={g.id}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-stone-700 hover:bg-stone-100"
                onClick={() => {
                  setDetail({ ...detail, groupIds: [...detail.groupIds, g.id] });
                  addToGroup(detail.contact.id, g.id);
                  setOpen(false);
                }}
              >
                <span
                  className="size-1.5 rounded-full"
                  style={{ backgroundColor: g.color }}
                />
                {g.name}
              </button>
            ))
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

// ---------- Notes ----------

function NotesSection({
  detail,
  setDetail,
}: {
  detail: ContactDetail;
  setDetail: (d: ContactDetail) => void;
}) {
  const [draft, setDraft] = useState("");
  const [pending, startTransition] = useTransition();
  const first = detail.contact.firstName ?? detail.contact.fullName.split(" ")[0];

  function submit() {
    const body = draft.trim();
    if (!body) return;
    startTransition(async () => {
      const note = await addNote(detail.contact.id, body);
      setDetail({ ...detail, notes: [note, ...detail.notes] });
      setDraft("");
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-stone-200 bg-stone-50 focus-within:border-stone-300 focus-within:bg-white">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`Add a note about ${first}…`}
          rows={2}
          className="min-h-0 resize-none border-0 bg-transparent text-[13.5px] shadow-none focus-visible:ring-0"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
          }}
        />
        {draft.trim() ? (
          <div className="flex justify-end px-2 pb-2">
            <Button size="sm" className="h-7 text-[12.5px]" onClick={submit} disabled={pending}>
              <Check className="size-3.5" /> Save
            </Button>
          </div>
        ) : null}
      </div>

      {detail.notes.map((n) => (
        <NoteCard
          key={n.id}
          note={n}
          onDeleted={() =>
            setDetail({
              ...detail,
              notes: detail.notes.filter((x) => x.id !== n.id),
            })
          }
          onEdited={(body) =>
            setDetail({
              ...detail,
              notes: detail.notes.map((x) =>
                x.id === n.id ? { ...x, body } : x,
              ),
            })
          }
        />
      ))}
    </div>
  );
}

function NoteCard({
  note,
  onDeleted,
  onEdited,
}: {
  note: ContactDetail["notes"][number];
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
    <div className="group/note relative rounded-lg bg-stone-50 px-3 py-2.5">
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
      <div className="absolute right-1.5 top-1.5 flex gap-0.5 opacity-0 transition-opacity group-hover/note:opacity-100">
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
