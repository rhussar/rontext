"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, ClipboardPaste, SmilePlus, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import {
  imageFromClipboardEvent,
  imageUrlFromClipboardEvent,
  readClipboardImage,
  type ClipboardImage,
} from "@/lib/clipboard-image";
import { cn } from "@/lib/utils";
import { PersonAvatar } from "@/components/person-avatar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/**
 * Click an avatar, change the picture — the same three moves as the graph's
 * logo manager (upload, paste, remove), just attached to the face itself.
 *
 * Deliberately owns none of the persistence: the profile writes through
 * immediately, while the new-person dialog holds the pick until the contact
 * exists and has an id to attach it to.
 */
export function PhotoPicker({
  name,
  src,
  onPicked,
  onRemoved,
  className = "size-24",
  textClass = "text-[28px]",
  busy = false,
}: {
  name: string;
  /** Current image, or null to show initials / the empty placeholder. */
  src: string | null;
  onPicked: (image: ClipboardImage) => void;
  /** Omit while there's nothing stored — the Remove row hides itself. */
  onRemoved?: () => void;
  className?: string;
  textClass?: string;
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // ⌘V while the picker is open, so the muscle memory from the logo manager
  // works here too without aiming at the Paste row.
  useEffect(() => {
    if (!open) return;
    function handlePaste(e: ClipboardEvent) {
      const file = imageFromClipboardEvent(e);
      if (file) {
        e.preventDefault();
        take({ kind: "file", file });
        return;
      }
      const url = imageUrlFromClipboardEvent(e);
      if (url) {
        e.preventDefault();
        take({ kind: "url", url });
      }
    }
    function take(image: ClipboardImage) {
      onPicked(image);
      setOpen(false);
    }
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [open, onPicked]);

  async function pasteFromClipboard() {
    const pasted = await readClipboardImage();
    if (!pasted) {
      toast.error("No image on your clipboard — copy one first, or use Upload.");
      return;
    }
    onPicked(pasted);
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            disabled={busy}
            aria-label={src ? "Change photo" : "Add photo"}
            title={src ? "Change photo" : "Add photo"}
            className={cn(
              "group/photo relative shrink-0 rounded-full outline-none",
              "focus-visible:ring-2 focus-visible:ring-stone-400 focus-visible:ring-offset-2",
              className,
            )}
          >
            {src || name.trim() ? (
              <PersonAvatar
                name={name || "?"}
                photoSrc={src}
                className="size-full"
                textClass={textClass}
              />
            ) : (
              // Nothing typed yet in the new-person dialog — a bare initials
              // circle would just be a coloured blob.
              <span className="flex size-full items-center justify-center rounded-full bg-stone-100">
                <SmilePlus className="size-8 text-stone-300" />
              </span>
            )}
            <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/45 opacity-0 transition-opacity group-hover/photo:opacity-100 group-focus-visible/photo:opacity-100">
              <Camera className="size-5 text-white" />
            </span>
          </button>
        }
      />
      <PopoverContent align="center" className="w-56 p-1.5">
        <PickerRow icon={Upload} onClick={() => fileRef.current?.click()}>
          {src ? "Replace photo" : "Upload a photo"}
        </PickerRow>
        <PickerRow icon={ClipboardPaste} onClick={pasteFromClipboard}>
          Paste from clipboard
        </PickerRow>
        {src && onRemoved ? (
          <PickerRow
            icon={Trash2}
            destructive
            onClick={() => {
              onRemoved();
              setOpen(false);
            }}
          >
            Remove photo
          </PickerRow>
        ) : null}
      </PopoverContent>

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/x-icon,image/vnd.microsoft.icon"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = ""; // allow re-picking the same file
          if (!file) return;
          onPicked({ kind: "file", file });
          setOpen(false);
        }}
      />
    </Popover>
  );
}

function PickerRow({
  icon: Icon,
  children,
  onClick,
  destructive = false,
}: {
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px]",
        destructive
          ? "text-red-600 hover:bg-red-50"
          : "text-stone-700 hover:bg-stone-100",
      )}
    >
      <Icon className="size-4 text-stone-400" />
      {children}
    </button>
  );
}
