"use client";

import { useRef, useState, useTransition, type Dispatch, type SetStateAction } from "react";
import { Check, Copy, FileText, Plus, Trash2, Upload, X } from "lucide-react";
import { toast } from "sonner";
import {
  addEducation,
  addToGroup,
  removeContactDoc,
  removeEducation,
  removeFromGroup,
  updateContact,
  updateEducation,
  uploadContactDoc,
  type ContactDetail,
  type ContactPatch,
  type EducationPatch,
} from "@/lib/actions/contacts";
import { copyText } from "@/lib/clipboard-text";
import { ago, formatPhone, linkedinSlug, reachOutSentence } from "@/lib/format";
import type { GroupWithCount } from "@/components/app-shell";
import { LocationMap } from "@/components/location-map";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="pb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </p>
  );
}

export function PersonAboutTab({
  detail,
  setDetail,
  groups,
}: {
  detail: ContactDetail;
  /**
   * The raw useState dispatcher, not the narrowed `(d) => void` the timeline
   * tab takes. Education and Files both fire slow server actions, so their
   * optimistic writes have to be functional updates — a plain `{...detail}`
   * built from a closure captured before the await will clobber anything that
   * landed in between (attach a PDF, click Add education while it uploads, and
   * the slower one wins).
   */
  setDetail: Dispatch<SetStateAction<ContactDetail | null>>;
  groups: GroupWithCount[];
}) {
  const c = detail.contact;
  const sentence = reachOutSentence(c);

  function save(patch: ContactPatch) {
    const merged = { ...detail.contact, ...patch } as ContactDetail["contact"];
    if ("firstName" in patch || "lastName" in patch) {
      const joined = [merged.firstName, merged.lastName]
        .filter(Boolean)
        .join(" ");
      if (joined) merged.fullName = joined;
    }
    // Mirror the server-side cache reset so a stale map doesn't linger on screen.
    if ("location" in patch) {
      merged.latitude = null;
      merged.longitude = null;
      merged.geocodedAt = null;
    }
    setDetail({ ...detail, contact: merged });
    updateContact(c.id, patch).catch(() => toast.error("Couldn't save"));
  }

  const splitList = (v: string) =>
    v
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter(Boolean);

  return (
    <div className="flex flex-col gap-6 px-6 pb-24">
      <section>
        <SectionLabel>Groups</SectionLabel>
        <GroupChips detail={detail} setDetail={setDetail} groups={groups} />
      </section>

      {sentence || c.interactionSources.length > 0 || c.linkedinUrl ? (
        <section>
          <SectionLabel>Sources</SectionLabel>
          {sentence ? (
            <p className="pb-2 text-[13.5px] leading-relaxed text-muted-foreground">
              {sentence}
            </p>
          ) : null}
          {c.linkedinUrl ? (
            <a
              href={c.linkedinUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 py-1 text-[13.5px] text-foreground underline decoration-muted-foreground/40 underline-offset-2 hover:decoration-muted-foreground"
            >
              <span className="flex size-[15px] items-center justify-center rounded-[3px] bg-[#0a66c2] text-[8.5px] font-bold text-white">
                in
              </span>
              {linkedinSlug(c.linkedinUrl)}
            </a>
          ) : null}
          {c.interactionSources.length > 0 ? (
            <p className="pt-1 text-[12px] text-muted-foreground">
              Known from: {c.interactionSources.join(", ")}
            </p>
          ) : null}
        </section>
      ) : null}

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
            // Multiple emails can live here, but there's only one "primary" to
            // copy — the first, same one every other lookup in the app treats
            // as canonical.
            copyValue={c.emails[0] ?? ""}
            placeholder="one@a.com; two@b.com"
            onSave={(v) => save({ emails: splitList(v) })}
          />
          <EditableField
            label="Phones"
            value={c.phoneNumbers.map(formatPhone).join("; ")}
            copyValue={c.phoneNumbers[0] ? formatPhone(c.phoneNumbers[0]) : ""}
            onSave={(v) => save({ phoneNumbers: splitList(v).map(formatPhone) })}
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

      <section>
        <SectionLabel>Education</SectionLabel>
        <EducationSection detail={detail} setDetail={setDetail} />
      </section>

      <section>
        <SectionLabel>Files</SectionLabel>
        <DocsSection detail={detail} setDetail={setDetail} />
      </section>

      {c.location ? (
        <section>
          <SectionLabel>Location</SectionLabel>
          <p className="pb-2 text-[13.5px] text-muted-foreground">{c.location}</p>
          {c.latitude != null && c.longitude != null ? (
            <LocationMap latitude={c.latitude} longitude={c.longitude} />
          ) : null}
        </section>
      ) : null}

      <section>
        <SectionLabel>Properties</SectionLabel>
        <div className="flex flex-col gap-1.5 text-[12px]">
          <PropRow label="Created" value={ago(c.createdAt) ?? ""} />
          <PropRow label="Last updated" value={ago(c.updatedAt) ?? ""} />
          {c.source !== "manual" ? (
            <PropRow
              label="Source"
              value={c.source === "linkedin" ? "LinkedIn sync" : "CSV import"}
            />
          ) : null}
        </div>
      </section>
    </div>
  );
}

function PropRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="uppercase tracking-wide text-muted-foreground">{value}</span>
    </div>
  );
}

function EditableField({
  label,
  value,
  onSave,
  type = "text",
  placeholder,
  copyValue = value,
}: {
  label: string;
  value: string;
  onSave: (value: string) => void;
  type?: string;
  placeholder?: string;
  /** What Copy actually copies — defaults to `value`, but a multi-value field
   * like Emails passes just the primary one. */
  copyValue?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [synced, setSynced] = useState(value);

  // Pull in edits that landed from elsewhere (a save, a re-import) without
  // clobbering what's being typed. React's documented adjust-on-render pattern.
  if (value !== synced) {
    setSynced(value);
    setDraft(value);
  }

  function commit() {
    const next = draft.trim();
    if (next === value.trim()) return;
    onSave(next);
  }

  return (
    <div className="group flex items-center gap-1 border-b border-border py-1.5 last:border-0">
      <span className="w-24 shrink-0 text-[12px] text-muted-foreground">{label}</span>
      <input
        type={type}
        value={draft}
        placeholder={placeholder ?? "—"}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        // The browser's native double-click selects one "word" and stops at
        // punctuation, so "jane@x.com" only ever grabs "jane" or "x". Select
        // the whole field instead — that's what a double-click is for here.
        onDoubleClick={(e) => e.currentTarget.select()}
        className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-[13.5px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/50 hover:bg-muted/50 focus:border-input focus:bg-background"
      />
      <CopyButton value={copyValue} />
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="size-6 shrink-0" aria-hidden />;

  return (
    <button
      type="button"
      aria-label={`Copy ${value}`}
      title="Copy"
      onClick={async () => {
        if (await copyText(value)) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } else {
          toast.error("Couldn't copy");
        }
      }}
      className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/50 opacity-0 transition-opacity hover:bg-muted hover:text-muted-foreground focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
    >
      {copied ? (
        <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
      ) : (
        <Copy className="size-3.5" />
      )}
    </button>
  );
}

/**
 * One inline input with the same draft/synced contract as EditableField —
 * blur-to-save, Enter blurs, no-op when unchanged. Split out because the
 * education rows need the behaviour without EditableField's fixed label
 * column and copy button.
 */
function InlineInput({
  value,
  onSave,
  placeholder,
  className = "",
  maxLength,
  inputMode,
  ariaLabel,
}: {
  value: string;
  onSave: (value: string) => void;
  placeholder?: string;
  className?: string;
  maxLength?: number;
  inputMode?: "numeric";
  ariaLabel: string;
}) {
  const [draft, setDraft] = useState(value);
  const [synced, setSynced] = useState(value);

  if (value !== synced) {
    setSynced(value);
    setDraft(value);
  }

  return (
    <input
      value={draft}
      aria-label={ariaLabel}
      placeholder={placeholder}
      maxLength={maxLength}
      inputMode={inputMode}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const next = draft.trim();
        if (next === value.trim()) return;
        onSave(next);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      onDoubleClick={(e) => e.currentTarget.select()}
      className={`min-w-0 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-foreground outline-none transition-colors placeholder:text-muted-foreground/50 hover:bg-muted/50 focus:border-input focus:bg-background ${className}`}
    />
  );
}

function EducationSection({
  detail,
  setDetail,
}: {
  detail: ContactDetail;
  setDetail: Dispatch<SetStateAction<ContactDetail | null>>;
}) {
  const [busy, startTransition] = useTransition();

  function patchRow(id: number, patch: EducationPatch) {
    // Optimistic, same as the Details fields: the row already reads the way the
    // user typed it, and the server action only has to agree.
    setDetail((prev) =>
      prev
        ? {
            ...prev,
            education: prev.education.map((e) =>
              e.id === id
                ? {
                    ...e,
                    ...(patch.school !== undefined ? { school: patch.school } : {}),
                    ...(patch.degree !== undefined ? { degree: patch.degree || null } : {}),
                    ...(patch.startYear !== undefined
                      ? { startYear: patch.startYear ? Number(patch.startYear) : null }
                      : {}),
                    ...(patch.endYear !== undefined
                      ? { endYear: patch.endYear ? Number(patch.endYear) : null }
                      : {}),
                  }
                : e,
            ),
          }
        : prev,
    );
    updateEducation(id, patch).catch(() => toast.error("Couldn't save"));
  }

  return (
    <div className="flex flex-col">
      {detail.education.map((edu) => (
        <div
          key={edu.id}
          className="group flex flex-col gap-0.5 border-b border-border py-2 last:border-0"
        >
          <div className="flex items-center gap-1">
            <InlineInput
              value={edu.school}
              ariaLabel="School"
              placeholder="School"
              className="flex-1 text-[13.5px] font-medium"
              onSave={(v) => patchRow(edu.id, { school: v })}
            />
            <button
              type="button"
              aria-label="Remove education"
              title="Remove"
              disabled={busy}
              onClick={() => {
                setDetail((prev) =>
                  prev
                    ? { ...prev, education: prev.education.filter((e) => e.id !== edu.id) }
                    : prev,
                );
                startTransition(async () => {
                  await removeEducation(edu.id);
                });
              }}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/50 opacity-0 transition-opacity hover:bg-muted hover:text-muted-foreground focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
          <div className="flex items-center gap-1 pr-6">
            <InlineInput
              value={edu.degree ?? ""}
              ariaLabel="Degree or field"
              placeholder="Degree or field"
              className="flex-1 text-[13px] text-muted-foreground"
              onSave={(v) => patchRow(edu.id, { degree: v })}
            />
            <InlineInput
              value={edu.startYear?.toString() ?? ""}
              ariaLabel="Start year"
              placeholder="From"
              inputMode="numeric"
              maxLength={4}
              className="w-14 text-center text-[13px] text-muted-foreground"
              onSave={(v) => patchRow(edu.id, { startYear: v })}
            />
            <span className="shrink-0 text-[12px] text-muted-foreground/50">–</span>
            <InlineInput
              value={edu.endYear?.toString() ?? ""}
              ariaLabel="End year"
              placeholder="To"
              inputMode="numeric"
              maxLength={4}
              className="w-14 text-center text-[13px] text-muted-foreground"
              onSave={(v) => patchRow(edu.id, { endYear: v })}
            />
          </div>
        </div>
      ))}

      <button
        type="button"
        disabled={busy}
        onClick={() =>
          startTransition(async () => {
            const row = await addEducation(detail.contact.id);
            // Prepend: a blank row has no endYear, and the server sorts nulls
            // first, so this matches what a refetch would return.
            setDetail((prev) =>
              prev ? { ...prev, education: [row, ...prev.education] } : prev,
            );
          })
        }
        className="mt-1.5 flex w-fit items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
      >
        <Plus className="size-3.5" />
        Add education
      </button>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function DocsSection({
  detail,
  setDetail,
}: {
  detail: ContactDetail;
  setDetail: Dispatch<SetStateAction<ContactDetail | null>>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, startTransition] = useTransition();

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    // Snapshot before clearing — FileList is live and value="" empties it.
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (!files.length) return;

    startTransition(async () => {
      // Sequential rather than Promise.all: each upload is a multi-MB server
      // action, and firing four at once is how you hit the body-size ceiling
      // on the slowest of them.
      const added: ContactDetail["docs"] = [];
      for (const file of files) {
        const fd = new FormData();
        fd.set("file", file);
        const result = await uploadContactDoc(detail.contact.id, fd);
        if (result.ok) {
          added.push(result.doc);
          toast.success(`${result.doc.filename} attached`);
        } else {
          toast.error(result.error);
        }
      }
      // Applied once, and functionally: PersonDetail holds `detail` in client
      // state loaded by its own effect, so revalidatePath never reaches it —
      // this optimistic write IS the refresh. Reading `prev` rather than the
      // captured `detail` is what keeps an education row added mid-upload from
      // being clobbered.
      if (added.length) {
        setDetail((prev) =>
          prev ? { ...prev, docs: [...added.reverse(), ...prev.docs] } : prev,
        );
      }
    });
  }

  return (
    <div className="flex flex-col gap-1.5">
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        className="hidden"
        onChange={onPick}
      />

      {detail.docs.map((doc) => (
        <div
          key={doc.id}
          className="group flex min-w-0 items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2"
        >
          <FileText className="size-4 shrink-0 text-foreground/70" />
          <a
            href={`/api/contact-docs/${doc.id}`}
            target="_blank"
            rel="noreferrer"
            title={doc.filename}
            className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground hover:underline"
          >
            {doc.filename}
            <span className="ml-1.5 font-normal text-muted-foreground">
              {formatBytes(doc.byteSize)}
            </span>
          </a>
          <button
            type="button"
            aria-label={`Remove ${doc.filename}`}
            title="Remove"
            disabled={busy}
            onClick={() => {
              setDetail((prev) =>
                prev ? { ...prev, docs: prev.docs.filter((d) => d.id !== doc.id) } : prev,
              );
              startTransition(async () => {
                await removeContactDoc(doc.id);
              });
            }}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/50 opacity-0 transition-opacity hover:bg-muted hover:text-muted-foreground focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      ))}

      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        className="mt-0.5 flex w-fit items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
      >
        <Upload className="size-3.5" />
        {busy ? "Uploading…" : "Attach PDF"}
      </button>
    </div>
  );
}

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
          className="flex items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-1 text-[12px] font-medium uppercase tracking-wide text-muted-foreground"
        >
          <span
            className="size-1.5 rounded-full"
            style={{ backgroundColor: g.color }}
          />
          {g.name}
          <button
            aria-label={`Remove from ${g.name}`}
            className="text-muted-foreground/50 hover:text-muted-foreground"
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
            <button className="flex items-center gap-1 rounded-md border border-dashed border-input px-2 py-1 text-[12px] font-medium text-muted-foreground hover:border-muted-foreground/40 hover:text-muted-foreground">
              <Plus className="size-3" /> Add
            </button>
          }
        />
        <PopoverContent align="start" className="w-48 p-1">
          {available.length === 0 ? (
            <p className="px-2 py-1.5 text-[12.5px] text-muted-foreground">
              No more groups. Create one from the sidebar.
            </p>
          ) : (
            available.map((g) => (
              <button
                key={g.id}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-foreground hover:bg-muted"
                onClick={() => {
                  setDetail({
                    ...detail,
                    groupIds: [...detail.groupIds, g.id],
                  });
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
