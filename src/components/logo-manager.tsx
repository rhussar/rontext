"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Building2,
  ClipboardPaste,
  GraduationCap,
  Image as ImageIcon,
  MapPin,
  Upload,
  Users,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  importEntityLogoFromUrl,
  listLogoEntities,
  removeEntityLogo,
  uploadEntityLogo,
  type LogoEntityRow,
} from "@/lib/actions/logos";
import { readClipboardImage } from "@/lib/clipboard-image";
import { HUB_COLOR, HUB_COLOR_FALLBACK } from "@/lib/graph/colors";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

const TYPE_ICON = {
  company: Building2,
  school: GraduationCap,
  place: MapPin,
  group: Users,
} as const;

/**
 * Add / replace / remove hub logos, in the same simple popover shape as the
 * alerts menu. One list, one search box, two actions per row — nothing more.
 */
export function LogoManager() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<LogoEntityRow[] | null>(null);
  const [query, setQuery] = useState("");
  const [pending, startTransition] = useTransition();

  const fileInputRef = useRef<HTMLInputElement>(null);
  // Which entity the hidden file input is currently uploading for
  const uploadTargetRef = useRef<number | null>(null);

  function reload() {
    listLogoEntities().then(setRows);
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next && rows === null) reload();
    if (!next) setQuery("");
  }

  function pickFile(entityId: number) {
    uploadTargetRef.current = entityId;
    fileInputRef.current?.click();
  }

  function uploadFile(entityId: number, file: File) {
    const fd = new FormData();
    fd.set("file", file);
    startTransition(async () => {
      const result = await uploadEntityLogo(entityId, fd);
      if (result.ok) {
        toast.success("Logo updated");
        reload();
        router.refresh(); // rebuilds the canvas with the new image
      } else {
        toast.error(result.error);
      }
    });
  }

  function onFileChosen(file: File | null) {
    const entityId = uploadTargetRef.current;
    uploadTargetRef.current = null;
    if (!file || entityId === null) return;
    uploadFile(entityId, file);
  }

  async function pasteForRow(row: LogoEntityRow) {
    const pasted = await readClipboardImage();
    if (!pasted) {
      toast.error("No image on your clipboard — copy one first, or use Upload.");
      return;
    }
    if (pasted.kind === "file") {
      uploadFile(row.id, pasted.file);
      return;
    }
    // A pasted LinkedIn copy is usually a CDN link, not a bitmap — the
    // server downloads it (no CORS there).
    startTransition(async () => {
      const result = await importEntityLogoFromUrl(row.id, pasted.url);
      if (result.ok) {
        toast.success("Logo updated");
        reload();
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function remove(row: LogoEntityRow) {
    startTransition(async () => {
      await removeEntityLogo(row.id);
      toast.success(`Removed logo for ${row.name}`);
      reload();
      router.refresh();
    });
  }

  const q = query.trim().toLowerCase();
  const visible = rows
    ? q
      ? rows.filter((r) => r.name.toLowerCase().includes(q))
      : rows
    : [];

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <button
            aria-label="Edit logos"
            className="flex size-9 items-center justify-center rounded-full bg-stone-200/80 text-stone-500 transition-colors hover:bg-stone-300/80"
          >
            <ImageIcon className="size-4" />
          </button>
        }
      />
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[360px] max-w-[calc(100vw-1.5rem)] p-0"
      >
        <div className="border-b border-stone-200 bg-stone-50 px-4 py-2.5">
          <p className="text-[11.5px] font-semibold uppercase tracking-[0.12em] text-stone-500">
            Logos &amp; icons
          </p>
        </div>

        <div className="border-b border-stone-100 px-3 py-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search companies, schools, places…"
            className="h-8 text-[13px]"
          />
        </div>

        <div className="max-h-[min(55vh,24rem)] overflow-y-auto py-1">
          {rows === null ? (
            <div className="flex flex-col gap-2.5 px-4 py-3">
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-4/5" />
              <Skeleton className="h-6 w-full" />
            </div>
          ) : visible.length === 0 ? (
            <p className="px-4 py-6 text-center text-[13px] text-stone-400">
              No matches.
            </p>
          ) : (
            <ul>
              {visible.map((row) => {
                const TypeIcon = TYPE_ICON[row.type as keyof typeof TYPE_ICON] ?? Building2;
                return (
                  <li
                    key={row.id}
                    className="group/row flex items-center gap-2.5 px-4 py-1.5 hover:bg-stone-50"
                  >
                    {row.logoV ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={`/api/logos/${row.id}?v=${row.logoV}`}
                        alt=""
                        className="size-6 shrink-0 rounded-md border border-stone-200 bg-white object-contain p-0.5"
                      />
                    ) : (
                      <span
                        className="flex size-6 shrink-0 items-center justify-center rounded-full"
                        style={{ backgroundColor: HUB_COLOR[row.type] ?? HUB_COLOR_FALLBACK }}
                      >
                        <TypeIcon className="size-3 text-white/90" />
                      </span>
                    )}

                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-stone-700">
                        {row.name}
                      </span>
                    </span>
                    <span className="shrink-0 text-[11px] tabular-nums text-stone-400">
                      {row.memberCount}
                    </span>

                    <button
                      aria-label={`${row.logoV ? "Replace" : "Add"} logo for ${row.name}`}
                      title={row.logoV ? "Replace logo" : "Add logo"}
                      disabled={pending}
                      onClick={() => pickFile(row.id)}
                      className="rounded p-1 text-stone-400 opacity-0 transition-opacity hover:bg-stone-200/70 hover:text-stone-700 group-hover/row:opacity-100"
                    >
                      <Upload className="size-3.5" />
                    </button>
                    <button
                      aria-label={`Paste logo for ${row.name} from clipboard`}
                      title="Paste image from clipboard"
                      disabled={pending}
                      onClick={() => pasteForRow(row)}
                      className="rounded p-1 text-stone-400 opacity-0 transition-opacity hover:bg-stone-200/70 hover:text-stone-700 group-hover/row:opacity-100"
                    >
                      <ClipboardPaste className="size-3.5" />
                    </button>
                    <button
                      aria-label={`Remove logo for ${row.name}`}
                      title="Remove logo"
                      disabled={pending || !row.logoV}
                      onClick={() => remove(row)}
                      className={
                        row.logoV
                          ? "rounded p-1 text-stone-400 opacity-0 transition-opacity hover:bg-stone-200/70 hover:text-red-600 group-hover/row:opacity-100"
                          : "invisible p-1"
                      }
                    >
                      <X className="size-3.5" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <p className="border-t border-stone-200 px-4 py-2 text-[11.5px] text-stone-400">
          PNG, JPG, WebP or ICO, under 500 KB. Square images look best. Copy
          an image, hover a row, and hit the paste icon.
        </p>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/x-icon,image/vnd.microsoft.icon"
          className="hidden"
          onChange={(e) => {
            onFileChosen(e.target.files?.[0] ?? null);
            e.target.value = ""; // allow re-picking the same file
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
