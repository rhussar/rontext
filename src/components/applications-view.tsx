"use client";

import { useRef, useState, useTransition } from "react";
import {
  BriefcaseBusiness,
  ChevronRight,
  ExternalLink,
  FileText,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { ApplicationDocKind } from "@/db/schema";
import {
  createApplication,
  deleteApplication,
  removeApplicationDoc,
  updateApplication,
  uploadApplicationDoc,
  type ApplicationDocMeta,
  type ApplicationListItem,
} from "@/lib/actions/applications";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

function appliedDate(iso: string): string {
  // Parse as local calendar parts — new Date("YYYY-MM-DD") is UTC midnight
  // and renders a day early in any western timezone.
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** One PDF slot — resume or cover letter — with upload / view / replace / remove. */
function DocSlot({
  applicationId,
  kind,
  label,
  doc,
}: {
  applicationId: number;
  kind: ApplicationDocKind;
  label: string;
  doc: ApplicationDocMeta | null;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, startTransition] = useTransition();

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    // Snapshot before clearing — FileList is live and value="" empties it.
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    const file = files[0];
    if (!file) return;
    const fd = new FormData();
    fd.set("file", file);
    startTransition(async () => {
      const result = await uploadApplicationDoc(applicationId, kind, fd);
      if (result.ok) toast.success(`${label} attached`);
      else toast.error(result.error);
    });
  }

  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={onPick}
      />
      <FileText
        className={cn(
          "size-4 shrink-0",
          doc ? "text-foreground/70" : "text-muted-foreground/50",
        )}
      />
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        {doc ? (
          <a
            href={`/api/application-docs/${doc.id}`}
            target="_blank"
            rel="noreferrer"
            className="block truncate text-[13px] font-medium text-foreground hover:underline"
            title={doc.filename}
          >
            {doc.filename}
            <span className="ml-1.5 font-normal text-muted-foreground">
              {formatBytes(doc.byteSize)}
            </span>
          </a>
        ) : (
          <p className="text-[13px] text-muted-foreground">No PDF yet</p>
        )}
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 gap-1.5 px-2 text-[12px] text-muted-foreground"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        <Upload className="size-3.5" />
        {busy ? "Uploading…" : doc ? "Replace" : "Upload"}
      </Button>
      {doc && (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-muted-foreground"
          aria-label={`Remove ${label.toLowerCase()}`}
          disabled={busy}
          onClick={() =>
            startTransition(async () => {
              await removeApplicationDoc(doc.id);
              toast.success(`${label} removed`);
            })
          }
        >
          <Trash2 className="size-3.5" />
        </Button>
      )}
    </div>
  );
}

function ApplicationRow({
  item,
  expanded,
  onToggle,
}: {
  item: ApplicationListItem;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [, startTransition] = useTransition();

  function saveField(patch: Parameters<typeof updateApplication>[1]) {
    startTransition(async () => {
      await updateApplication(item.id, patch);
    });
  }

  return (
    <div className="border-b border-border">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-muted/50"
      >
        <ChevronRight
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-90",
          )}
        />
        <span className="w-40 shrink-0 truncate text-[14.5px] font-semibold text-foreground sm:w-52">
          {item.company}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13.5px] text-muted-foreground">
          {item.role}
        </span>
        <span className="hidden shrink-0 items-center gap-1 sm:flex">
          {item.resume && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Resume
            </span>
          )}
          {item.coverLetter && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Cover
            </span>
          )}
        </span>
        <span className="shrink-0 pl-3 text-[10.5px] uppercase tracking-wide text-muted-foreground">
          {item.appliedOn ? appliedDate(item.appliedOn) : "No date"}
        </span>
      </button>

      {expanded && (
        <div className="space-y-4 px-5 pb-5 pl-12">
          {/* Company / role / date — save on blur */}
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-40 flex-1">
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Company
              </span>
              <Input
                defaultValue={item.company}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== item.company) saveField({ company: v });
                }}
              />
            </label>
            <label className="min-w-40 flex-1">
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Role
              </span>
              <Input
                defaultValue={item.role}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== item.role) saveField({ role: v });
                }}
              />
            </label>
            <label>
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Applied on
              </span>
              <Input
                type="date"
                defaultValue={item.appliedOn ?? ""}
                onChange={(e) => saveField({ appliedOn: e.target.value || null })}
                className="w-40"
              />
            </label>
          </div>

          {/* Job link */}
          <div className="flex items-end gap-1.5">
            <label className="min-w-0 flex-1">
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Link
              </span>
              <Input
                // Keyed on the saved value so the server-normalized form
                // (https:// prepended) shows up after the round trip — a
                // defaultValue alone never updates a mounted input.
                key={item.url ?? ""}
                type="url"
                inputMode="url"
                placeholder="https://…"
                defaultValue={item.url ?? ""}
                onBlur={(e) => {
                  if ((e.target.value.trim() || null) !== item.url) {
                    saveField({ url: e.target.value });
                  }
                }}
              />
            </label>
            {item.url && (
              <Button
                variant="ghost"
                size="icon"
                className="size-9 shrink-0 text-muted-foreground"
                aria-label="Open job link"
                onClick={() => window.open(item.url!, "_blank", "noopener")}
              >
                <ExternalLink className="size-4" />
              </Button>
            )}
          </div>

          {/* Documents */}
          <div className="grid gap-2 lg:grid-cols-2">
            <DocSlot
              applicationId={item.id}
              kind="resume"
              label="Resume"
              doc={item.resume}
            />
            <DocSlot
              applicationId={item.id}
              kind="cover_letter"
              label="Cover letter"
              doc={item.coverLetter}
            />
          </div>

          {/* Notes */}
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Notes
            </span>
            <Textarea
              defaultValue={item.notes}
              placeholder="Recruiter names, interview dates, follow-ups…"
              className="min-h-24 text-[13.5px]"
              onBlur={(e) => {
                if (e.target.value !== item.notes) {
                  saveField({ notes: e.target.value });
                  toast.success("Notes saved");
                }
              }}
            />
          </label>

          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2 text-[12px] text-destructive hover:text-destructive"
              onClick={() => {
                if (
                  window.confirm(
                    `Delete the ${item.company} application? Its PDFs and notes go with it.`,
                  )
                ) {
                  startTransition(async () => {
                    await deleteApplication(item.id);
                    toast.success(`Deleted ${item.company}`);
                  });
                }
              }}
            >
              <Trash2 className="size-3.5" />
              Delete application
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function AddForm({
  onCreated,
  onCancel,
}: {
  onCreated: (id: number) => void;
  onCancel: () => void;
}) {
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [appliedOn, setAppliedOn] = useState(todayLocal());
  const [url, setUrl] = useState("");
  const [busy, startTransition] = useTransition();
  const canSave = company.trim().length > 0 && role.trim().length > 0;

  function submit() {
    if (!canSave) return;
    startTransition(async () => {
      const row = await createApplication(company, role, appliedOn || null, url);
      toast.success(`Added ${row.company}`);
      onCreated(row.id);
    });
  }

  return (
    <div className="border-b border-border bg-muted/30 px-5 py-4">
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-40 flex-1">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Company
          </span>
          <Input
            autoFocus
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            placeholder="Acme Corp"
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </label>
        <label className="min-w-40 flex-1">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Role
          </span>
          <Input
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="Product Manager"
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </label>
        <label>
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Applied on
          </span>
          <Input
            type="date"
            value={appliedOn}
            onChange={(e) => setAppliedOn(e.target.value)}
            className="w-40"
          />
        </label>
        <label className="min-w-48 flex-1">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Link
          </span>
          <Input
            type="url"
            inputMode="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…"
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </label>
        <div className="flex gap-1.5">
          <Button size="sm" disabled={!canSave || busy} onClick={submit}>
            {busy ? "Adding…" : "Add"}
          </Button>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ApplicationsView({ items }: { items: ApplicationListItem[] }) {
  const [adding, setAdding] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center justify-between border-b border-border px-5 pb-2.5 pt-3">
        <h1 className="text-[15px] font-semibold text-foreground">
          Applications
          {items.length > 0 && (
            <span className="ml-2 text-[13px] font-normal text-muted-foreground">
              {items.length}
            </span>
          )}
        </h1>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 px-2.5 text-[12.5px]"
          onClick={() => setAdding((a) => !a)}
        >
          <Plus className="size-3.5" />
          Add application
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-10">
        {adding && (
          <AddForm
            onCreated={(id) => {
              setAdding(false);
              setExpandedId(id);
            }}
            onCancel={() => setAdding(false)}
          />
        )}
        {items.length === 0 && !adding ? (
          <div className="px-6 pt-16 text-center">
            <BriefcaseBusiness className="mx-auto mb-3 size-8 text-muted-foreground/50" />
            <p className="text-[13.5px] text-muted-foreground">
              No applications yet. Track a job you applied to, with the resume
              and cover letter you used.
            </p>
            <Button
              size="sm"
              variant="outline"
              className="mt-4"
              onClick={() => setAdding(true)}
            >
              <Plus className="size-3.5" />
              Add your first application
            </Button>
          </div>
        ) : (
          items.map((item) => (
            <ApplicationRow
              key={item.id}
              item={item}
              expanded={expandedId === item.id}
              onToggle={() =>
                setExpandedId((cur) => (cur === item.id ? null : item.id))
              }
            />
          ))
        )}
      </div>
    </div>
  );
}
