"use client";

import { useState } from "react";
import { Check, Copy, Plus, X } from "lucide-react";
import { toast } from "sonner";
import {
  addToGroup,
  removeFromGroup,
  updateContact,
  type ContactDetail,
  type ContactPatch,
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
    <p className="pb-2 text-[11px] font-semibold uppercase tracking-wider text-stone-400">
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
  setDetail: (d: ContactDetail) => void;
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

      {c.location ? (
        <section>
          <SectionLabel>Location</SectionLabel>
          <p className="pb-2 text-[13.5px] text-stone-600">{c.location}</p>
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
      <span className="uppercase tracking-wide text-stone-400">{label}</span>
      <span className="uppercase tracking-wide text-stone-500">{value}</span>
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
    <div className="group flex items-center gap-1 border-b border-stone-100 py-1.5 last:border-0">
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
        // The browser's native double-click selects one "word" and stops at
        // punctuation, so "jane@x.com" only ever grabs "jane" or "x". Select
        // the whole field instead — that's what a double-click is for here.
        onDoubleClick={(e) => e.currentTarget.select()}
        className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-[13.5px] text-stone-800 outline-none transition-colors placeholder:text-stone-300 hover:bg-stone-50 focus:border-stone-300 focus:bg-white"
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
      className="flex size-6 shrink-0 items-center justify-center rounded-md text-stone-300 opacity-0 transition-opacity hover:bg-stone-100 hover:text-stone-600 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
    >
      {copied ? (
        <Check className="size-3.5 text-emerald-600" />
      ) : (
        <Copy className="size-3.5" />
      )}
    </button>
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
          className="flex items-center gap-1.5 rounded-md border border-stone-200 bg-stone-50 px-2 py-1 text-[12px] font-medium uppercase tracking-wide text-stone-600"
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
