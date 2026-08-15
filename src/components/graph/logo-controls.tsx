"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Building2,
  ClipboardPaste,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  importEntityLogoFromUrl,
  listLogoEntities,
  removeEntityLogo,
  uploadEntityLogo,
  type LogoEntityRow,
  type LogoUploadResult,
} from "@/lib/actions/logos";
import { readClipboardImage, imageFromClipboardEvent, imageUrlFromClipboardEvent } from "@/lib/clipboard-image";
import type { GraphCompany } from "@/lib/graph/query";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

const ACCEPT =
  "image/png,image/jpeg,image/webp,image/gif,image/x-icon,image/vnd.microsoft.icon";

/**
 * The one copy of the upload/paste/import/remove flow both logo surfaces
 * share — CompanyLogoSection (the searchable list in Network settings) and
 * CompanyLogoButton (the selected hub's title). Owns the server-action calls,
 * the toasts, and the router.refresh() that rebuilds the canvas with the new
 * image.
 */
function useLogoActions(onSuccess?: () => void) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function finish(result: LogoUploadResult, name?: string) {
    if (result.ok) {
      toast.success(name ? `Logo updated for ${name}` : "Logo updated");
      onSuccess?.();
      router.refresh(); // rebuilds the canvas with the new image
    } else {
      toast.error(result.error);
    }
  }

  function uploadFile(entityId: number, file: File, name?: string) {
    const fd = new FormData();
    fd.set("file", file);
    startTransition(async () => finish(await uploadEntityLogo(entityId, fd), name));
  }

  function importUrl(entityId: number, url: string, name?: string) {
    // A pasted LinkedIn copy is usually a CDN link, not a bitmap — the
    // server downloads it (no CORS there).
    startTransition(async () => finish(await importEntityLogoFromUrl(entityId, url), name));
  }

  async function pasteClipboard(entityId: number, name?: string) {
    const pasted = await readClipboardImage();
    if (!pasted) {
      toast.error("No image on your clipboard — copy one first, or use Upload.");
      return;
    }
    if (pasted.kind === "file") uploadFile(entityId, pasted.file, name);
    else importUrl(entityId, pasted.url, name);
  }

  function remove(entityId: number, name: string) {
    startTransition(async () => {
      await removeEntityLogo(entityId);
      toast.success(`Removed logo for ${name}`);
      onSuccess?.();
      router.refresh();
    });
  }

  return { pending, uploadFile, importUrl, pasteClipboard, remove };
}

/**
 * Add / replace / remove company logos: one search box, three actions per row.
 *
 * A section, not a popover — it's rendered inside the Network settings
 * dropdown. The list loads on mount rather than behind an `open` flag, which
 * works because the dropdown unmounts its content when closed, so the query is
 * still paid only when the panel is actually opened.
 */
export function CompanyLogoSection() {
  const [rows, setRows] = useState<LogoEntityRow[] | null>(null);
  const [query, setQuery] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);
  // Which company the hidden file input is currently uploading for
  const uploadTargetRef = useRef<number | null>(null);

  const reload = () => listLogoEntities().then(setRows);
  const { pending, uploadFile, pasteClipboard, remove } = useLogoActions(reload);

  useEffect(() => {
    reload();
  }, []);

  function pickFile(entityId: number) {
    uploadTargetRef.current = entityId;
    fileInputRef.current?.click();
  }

  function onFileChosen(file: File | null) {
    const entityId = uploadTargetRef.current;
    uploadTargetRef.current = null;
    if (!file || entityId === null) return;
    uploadFile(entityId, file);
  }

  const q = query.trim().toLowerCase();
  const visible = rows
    ? q
      ? rows.filter((r) => r.name.toLowerCase().includes(q))
      : rows
    : [];

  return (
    <>
      <div className="border-b border-border px-3 py-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search companies…"
          className="h-8 text-[13px]"
        />
      </div>

      <div className="max-h-[min(45vh,20rem)] overflow-y-auto py-1">
        {rows === null ? (
          <div className="flex flex-col gap-2.5 px-4 py-3">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-4/5" />
            <Skeleton className="h-6 w-full" />
          </div>
        ) : visible.length === 0 ? (
          <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">
            No matches.
          </p>
        ) : (
          <ul>
            {visible.map((row) => (
              <li
                key={row.id}
                className="group/row flex items-center gap-2.5 px-4 py-1.5 hover:bg-muted/50"
              >
                {row.logoV ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/logos/${row.id}?v=${row.logoV}`}
                    alt=""
                    className="size-6 shrink-0 rounded-md border border-border bg-background object-contain p-0.5"
                  />
                ) : (
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-stone-500 dark:bg-stone-600">
                    <Building2 className="size-3 text-white/90" />
                  </span>
                )}

                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-foreground">
                    {row.name}
                  </span>
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {row.memberCount}
                </span>

                <button
                  aria-label={`${row.logoV ? "Replace" : "Add"} logo for ${row.name}`}
                  title={row.logoV ? "Replace logo" : "Add logo"}
                  disabled={pending}
                  onClick={() => pickFile(row.id)}
                  className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted-foreground/20 hover:text-foreground group-hover/row:opacity-100"
                >
                  <Upload className="size-3.5" />
                </button>
                <button
                  aria-label={`Paste logo for ${row.name} from clipboard`}
                  title="Paste image from clipboard"
                  disabled={pending}
                  onClick={() => pasteClipboard(row.id)}
                  className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted-foreground/20 hover:text-foreground group-hover/row:opacity-100"
                >
                  <ClipboardPaste className="size-3.5" />
                </button>
                <button
                  aria-label={`Remove logo for ${row.name}`}
                  title="Remove logo"
                  disabled={pending || !row.logoV}
                  onClick={() => remove(row.id, row.name)}
                  className={
                    row.logoV
                      ? "rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted-foreground/20 hover:text-red-600 dark:hover:text-red-400 group-hover/row:opacity-100"
                      : "invisible p-1"
                  }
                >
                  <X className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="border-t border-border px-4 py-2 text-[11.5px] text-muted-foreground">
        PNG, JPG, WebP or ICO, under 500 KB. Square images look best. Copy an
        image, hover a row, and hit the paste icon.
      </p>

      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          onFileChosen(e.target.files?.[0] ?? null);
          e.target.value = ""; // allow re-picking the same file
        }}
      />
    </>
  );
}

/**
 * The selected company's logo + name, shown as the panel title. Clicking it
 * opens the upload/remove actions for that one company — the same flow as
 * LogoManager, scoped to what you just clicked instead of a searchable list.
 */
export function CompanyLogoButton({ company }: { company: GraphCompany }) {
  const [open, setOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { pending, uploadFile, importUrl, pasteClipboard, remove } = useLogoActions(() =>
    setOpen(false),
  );

  function onFileChosen(file: File | null) {
    if (!file) return;
    uploadFile(company.id, file, company.name);
  }

  // While the popover's open, ⌘V anywhere pastes straight in — there's only
  // one company in play here, so the target is never ambiguous the way it
  // would be in LogoManager's list.
  useEffect(() => {
    if (!open) return;
    function onPaste(e: ClipboardEvent) {
      const file = imageFromClipboardEvent(e);
      if (file) {
        e.preventDefault();
        onFileChosen(file);
        return;
      }
      // No bitmap on the clipboard — the LinkedIn case, where the copy is an
      // HTML fragment referencing the CDN image. Ship the URL to the server.
      const url = imageUrlFromClipboardEvent(e);
      if (url) {
        e.preventDefault();
        importUrl(company.id, url, company.name);
      }
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <button
              aria-label={`${company.hasLogo ? "Change" : "Add"} logo for ${company.name}`}
              title={company.hasLogo ? "Change logo" : "Add a logo"}
              className="-mx-1.5 flex w-full items-center gap-2 rounded-md px-1.5 py-0.5 transition-colors hover:bg-muted"
            >
              {company.hasLogo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/api/logos/${company.id}${company.logoV ? `?v=${company.logoV}` : ""}`}
                  alt=""
                  className="size-7 shrink-0 rounded-md border border-border bg-background object-contain p-0.5"
                />
              ) : (
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-stone-500 dark:bg-stone-600">
                  <Building2 className="size-3.5 text-white/90" />
                </span>
              )}
              <span className="min-w-0 truncate text-[15px] font-semibold text-foreground">
                {company.name}
              </span>
            </button>
          }
        />
        <PopoverContent align="end" sideOffset={8} className="w-60 p-1">
          <p className="truncate px-2 pb-1 pt-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
            {company.name}
          </p>
          <button
            disabled={pending}
            onClick={() => fileInputRef.current?.click()}
            className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-left text-[13px] text-foreground hover:bg-muted disabled:opacity-50"
          >
            <Upload className="size-4 text-muted-foreground" />
            {company.hasLogo ? "Replace image" : "Upload image"}
          </button>
          <button
            disabled={pending}
            onClick={() => pasteClipboard(company.id, company.name)}
            className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-left text-[13px] text-foreground hover:bg-muted disabled:opacity-50"
          >
            <ClipboardPaste className="size-4 text-muted-foreground" />
            Paste image
          </button>
          {company.hasLogo ? (
            <button
              disabled={pending}
              onClick={() => remove(company.id, company.name)}
              className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-left text-[13px] text-foreground hover:bg-muted hover:text-red-600 dark:hover:text-red-400 disabled:opacity-50"
            >
              <Trash2 className="size-4 text-muted-foreground" />
              Remove image
            </button>
          ) : null}
        </PopoverContent>
      </Popover>

      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          onFileChosen(e.target.files?.[0] ?? null);
          e.target.value = ""; // allow re-picking the same file
        }}
      />
    </>
  );
}
