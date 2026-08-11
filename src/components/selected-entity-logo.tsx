"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Building2,
  ClipboardPaste,
  GraduationCap,
  MapPin,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import {
  importEntityLogoFromUrl,
  removeEntityLogo,
  uploadEntityLogo,
} from "@/lib/actions/logos";
import {
  imageFromClipboardEvent,
  imageUrlFromClipboardEvent,
  readClipboardImage,
} from "@/lib/clipboard-image";
import { HUB_COLOR, HUB_COLOR_FALLBACK } from "@/lib/graph/colors";
import type { GraphEntity } from "@/lib/actions/graph";
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

const ACCEPT =
  "image/png,image/jpeg,image/webp,image/gif,image/x-icon,image/vnd.microsoft.icon";

/**
 * The selected hub's logo, shown in the Network header. Clicking it opens the
 * upload/remove actions for that one entity — the same thing LogoManager does,
 * but scoped to what you just clicked instead of a searchable list.
 */
export function SelectedEntityLogo({ entity }: { entity: GraphEntity }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const TypeIcon = TYPE_ICON[entity.type as keyof typeof TYPE_ICON] ?? Building2;
  const color = HUB_COLOR[entity.type] ?? HUB_COLOR_FALLBACK;

  function finish(result: { ok: true } | { ok: false; error: string }) {
    if (result.ok) {
      toast.success(`Logo updated for ${entity.name}`);
      setOpen(false);
      router.refresh(); // rebuilds the canvas with the new image
    } else {
      toast.error(result.error);
    }
  }

  function onFileChosen(file: File | null) {
    if (!file) return;
    const fd = new FormData();
    fd.set("file", file);
    startTransition(async () => finish(await uploadEntityLogo(entity.id, fd)));
  }

  function onUrlPasted(url: string) {
    startTransition(async () => finish(await importEntityLogoFromUrl(entity.id, url)));
  }

  function remove() {
    startTransition(async () => {
      await removeEntityLogo(entity.id);
      toast.success(`Removed logo for ${entity.name}`);
      setOpen(false);
      router.refresh();
    });
  }

  async function pasteFromClipboard() {
    const pasted = await readClipboardImage();
    if (!pasted) {
      toast.error("No image on your clipboard — copy one first, or use Upload.");
      return;
    }
    if (pasted.kind === "file") onFileChosen(pasted.file);
    else onUrlPasted(pasted.url);
  }

  // While the popover's open, ⌘V anywhere pastes straight in — there's only
  // one entity in play here, so the target is never ambiguous the way it
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
        onUrlPasted(url);
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
              aria-label={`${entity.hasLogo ? "Change" : "Add"} logo for ${entity.name}`}
              title={entity.hasLogo ? "Change logo" : "Add a logo"}
              className="-mx-1.5 flex w-full items-center gap-2 rounded-md px-1.5 py-0.5 transition-colors hover:bg-stone-100"
            >
              {entity.hasLogo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/api/logos/${entity.id}${entity.logoV ? `?v=${entity.logoV}` : ""}`}
                  alt=""
                  className="size-7 shrink-0 rounded-md border border-stone-200 bg-white object-contain p-0.5"
                />
              ) : (
                <span
                  className="flex size-7 shrink-0 items-center justify-center rounded-md"
                  style={{ backgroundColor: color }}
                >
                  <TypeIcon className="size-3.5 text-white/90" />
                </span>
              )}
              <span className="min-w-0 truncate text-[15px] font-semibold text-stone-800">
                {entity.name}
              </span>
            </button>
          }
        />
        <PopoverContent align="end" sideOffset={8} className="w-60 p-1">
          <p className="truncate px-2 pb-1 pt-1.5 text-[11px] uppercase tracking-wider text-stone-400">
            {entity.name}
          </p>
          <button
            disabled={pending}
            onClick={() => fileInputRef.current?.click()}
            className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-left text-[13px] text-stone-700 hover:bg-stone-100 disabled:opacity-50"
          >
            <Upload className="size-4 text-stone-400" />
            {entity.hasLogo ? "Replace image" : "Upload image"}
          </button>
          <button
            disabled={pending}
            onClick={pasteFromClipboard}
            className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-left text-[13px] text-stone-700 hover:bg-stone-100 disabled:opacity-50"
          >
            <ClipboardPaste className="size-4 text-stone-400" />
            Paste image
          </button>
          {entity.hasLogo ? (
            <button
              disabled={pending}
              onClick={remove}
              className="flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-left text-[13px] text-stone-700 hover:bg-stone-100 hover:text-red-600 disabled:opacity-50"
            >
              <Trash2 className="size-4 text-stone-400" />
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
