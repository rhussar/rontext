"use client";

/**
 * Faithful "how this will look to the public" renderings of a draft, one per
 * platform. Deliberately hard-coded to each platform's LIGHT palette with
 * explicit hex values — the public sees the platform's default look, so these
 * cards must not re-theme with the app's dark mode.
 *
 * Fidelity notes (researched 2026-08):
 * - X shows the full text of a ≤280-char post; entities (links, #, @) render
 *   in #1d9bf0; links display without protocol and t.co-truncated (~27 chars).
 * - LinkedIn truncates the feed view by LINES, not characters — ~3 lines on
 *   desktop (≈210 chars) — behind an inline grey "…more". Reproduced with
 *   line-clamp-3 plus the same click-to-expand behavior.
 * - Instagram shows ~125 caption characters before an inline "… more", and a
 *   post cannot exist without media, so an imageless draft gets a placeholder
 *   slot instead of a fake photo.
 */

import { useEffect, useRef, useState } from "react";
import {
  Bookmark,
  ChartNoAxesColumn,
  ChevronLeft,
  ChevronRight,
  Earth,
  Heart,
  ImageIcon,
  MessageCircle,
  Repeat2,
  Send,
  ThumbsUp,
  Upload,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { avatarColor, initials } from "@/lib/format";
import type { SocialPostPlatform } from "@/db/schema";
import type { PlatformProfile } from "@/lib/social";

/**
 * Each card renders its own platform's identity record (photo, name, handle,
 * bio) — edited per-platform in Settings → General.
 */
export type PreviewProfiles = Record<
  "linkedin" | "x" | "instagram",
  PlatformProfile
>;

export type PreviewImage = {
  url: string;
  width: number | null;
  height: number | null;
};

const X_FONT =
  '"TwitterChirp", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const SYSTEM_FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

/** "2h" / "3d" / "Aug 3" — the short relative stamp all three feeds use. */
function shortTime(postedAt: string | null): string {
  if (!postedAt) return "now";
  const ms = Date.now() - new Date(postedAt).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(postedAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function Avatar({
  profile,
  size,
  square = false,
}: {
  profile: PlatformProfile;
  size: string;
  square?: boolean;
}) {
  const name = profile.name || "You";
  const shape = square ? "rounded-md" : "rounded-full";
  if (profile.avatar) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- data URL
      <img
        src={profile.avatar}
        alt=""
        className={cn("shrink-0 object-cover", shape, size)}
      />
    );
  }
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center font-semibold text-white",
        avatarColor(name),
        shape,
        size,
      )}
    >
      {initials(name)}
    </span>
  );
}

/** Editing hooks; present = the preview IS the composer's text editor. */
export type PreviewEditing = {
  onChange: (text: string) => void;
  /** ⌘Enter, same shortcut the old textarea had. */
  onSubmit?: () => void;
  placeholder: string;
};

/**
 * contentEditable divs represent an empty document as "<br>" and append a
 * trailing newline to innerText — normalize both away so state and DOM
 * compare equal and the caret never gets reset mid-typing.
 */
function normalizeEditable(text: string): string {
  return text.replace(/\n$/, "");
}

/**
 * The in-preview text editor: an uncontrolled contentEditable that only
 * writes to the DOM when the value changed somewhere ELSE (AI generation,
 * platform switch) — writing on every keystroke would reset the caret.
 * Plaintext-only, so a paste can't smuggle markup into the preview.
 *
 * While editing, entity highlighting is off (a live-highlighting editor is a
 * different animal); the read-only previews keep it.
 */
function EditableText({
  value,
  editing,
  onEditingChange,
  className,
  inline = false,
}: {
  value: string;
  editing: PreviewEditing;
  /** Focus tracking, so the cards can un-clamp while the caret is inside. */
  onEditingChange?: (editing: boolean) => void;
  className?: string;
  /** Instagram's caption flows inline after the bold handle. */
  inline?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && normalizeEditable(el.innerText) !== value) {
      el.innerText = value;
    }
  }, [value]);

  const Tag = inline ? "span" : "div";
  const editable = (
    <Tag
      ref={ref as React.Ref<HTMLDivElement & HTMLSpanElement>}
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label="Post text"
      onInput={() =>
        editing.onChange(normalizeEditable(ref.current?.innerText ?? ""))
      }
      onFocus={() => onEditingChange?.(true)}
      onBlur={() => onEditingChange?.(false)}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          editing.onSubmit?.();
        }
      }}
      className={cn(
        "cursor-text whitespace-pre-wrap break-words outline-none",
        !inline && "min-h-[1.25em]",
        className,
      )}
    />
  );

  if (inline) {
    return (
      <>
        {value === "" ? (
          <span
            className="select-none text-[#8e8e8e]"
            onClick={() => ref.current?.focus()}
          >
            {editing.placeholder}{" "}
          </span>
        ) : null}
        {editable}
      </>
    );
  }
  return (
    <div className="relative" onClick={() => ref.current?.focus()}>
      {value === "" ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 select-none text-[#8e8e8e]"
        >
          {editing.placeholder}
        </span>
      ) : null}
      {editable}
    </div>
  );
}

/**
 * Split text into plain runs and highlighted entities. One tokenizer for all
 * three platforms; only the highlight color differs.
 */
function richText(text: string, color: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(https?:\/\/\S+|#[\p{L}\p{N}_]+|@[\p{L}\p{N}_.]+)/gu;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    let shown = m[0];
    if (shown.startsWith("http")) {
      // X displays links stripped of protocol and cut at ~27 chars — do the
      // same everywhere; it's what all three platforms roughly do.
      shown = shown.replace(/^https?:\/\//, "").replace(/\/$/, "");
      if (shown.length > 27) shown = `${shown.slice(0, 27)}…`;
    }
    out.push(
      <span key={key++} style={{ color }}>
        {shown}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/* ------------------------------------------------------------------ *
 * Image layouts
 * ------------------------------------------------------------------ */

/** X's rounded media grid: 1 natural, 2 side-by-side, 3 one-tall-two-stacked, 4 grid. */
function XImageGrid({ images }: { images: PreviewImage[] }) {
  if (images.length === 0) return null;
  const img = (i: number, className: string) => (
    // eslint-disable-next-line @next/next/no-img-element -- app-served blobs
    <img
      key={images[i].url}
      src={images[i].url}
      alt=""
      className={cn("h-full w-full object-cover", className)}
    />
  );
  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-[#cfd9de]">
      {images.length === 1 ? (
        // eslint-disable-next-line @next/next/no-img-element -- app-served blob
        <img
          src={images[0].url}
          alt=""
          className="max-h-[420px] w-full object-cover"
          style={{
            aspectRatio:
              images[0].width && images[0].height
                ? `${images[0].width} / ${images[0].height}`
                : undefined,
          }}
        />
      ) : images.length === 2 ? (
        <div className="grid h-64 grid-cols-2 gap-px bg-[#cfd9de]">
          {img(0, "")}
          {img(1, "")}
        </div>
      ) : images.length === 3 ? (
        <div className="grid h-64 grid-cols-2 grid-rows-2 gap-px bg-[#cfd9de]">
          {img(0, "row-span-2")}
          {img(1, "")}
          {img(2, "")}
        </div>
      ) : (
        <div className="grid h-64 grid-cols-2 grid-rows-2 gap-px bg-[#cfd9de]">
          {img(0, "")}
          {img(1, "")}
          {img(2, "")}
          {img(3, "")}
        </div>
      )}
    </div>
  );
}

/** LinkedIn media: full-bleed, 1 natural, 2 columns, 3+ hero over a strip. */
function LinkedInImages({ images }: { images: PreviewImage[] }) {
  if (images.length === 0) return null;
  const img = (i: number, className = "") => (
    // eslint-disable-next-line @next/next/no-img-element -- app-served blobs
    <img
      key={images[i].url}
      src={images[i].url}
      alt=""
      className={cn("h-full w-full object-cover", className)}
    />
  );
  if (images.length === 1) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- app-served blob
      <img
        src={images[0].url}
        alt=""
        className="mt-2 max-h-[400px] w-full object-cover"
      />
    );
  }
  if (images.length === 2) {
    return (
      <div className="mt-2 grid h-60 grid-cols-2 gap-px bg-white">
        {img(0)}
        {img(1)}
      </div>
    );
  }
  return (
    <div className="mt-2">
      <div className="h-52">{img(0)}</div>
      <div
        className="mt-px grid h-28 gap-px bg-white"
        style={{ gridTemplateColumns: `repeat(${images.length - 1}, 1fr)` }}
      >
        {images.slice(1).map((_, i) => img(i + 1))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Platform cards
 * ------------------------------------------------------------------ */

type CardProps = {
  /** This card's own platform record. */
  profile: PlatformProfile;
  body: string;
  images: PreviewImage[];
  postedAt: string | null;
  /** Present = the text region is the editor. */
  editing?: PreviewEditing;
};

function XPreview({ profile, body, images, postedAt, editing }: CardProps) {
  const handle = profile.handle || "yourhandle";
  return (
    <div
      className="rounded-2xl border border-[#cfd9de] bg-white px-4 py-3"
      style={{ fontFamily: X_FONT }}
    >
      <div className="flex gap-3">
        <Avatar profile={profile} size="size-10" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1 text-[15px] leading-5">
            <span className="truncate font-bold text-[#0f1419]">
              {profile.name || "Your Name"}
            </span>
            <span className="truncate text-[#536471]">@{handle}</span>
            <span className="text-[#536471]">·</span>
            <span className="shrink-0 text-[#536471]">{shortTime(postedAt)}</span>
          </div>
          {editing ? (
            <EditableText
              value={body}
              editing={editing}
              className="pt-0.5 text-[15px] leading-5 text-[#0f1419]"
            />
          ) : (
            <div className="whitespace-pre-wrap break-words pt-0.5 text-[15px] leading-5 text-[#0f1419]">
              {richText(body, "#1d9bf0")}
            </div>
          )}
          <XImageGrid images={images} />
          <div className="flex max-w-[425px] items-center justify-between pt-3 text-[#536471]">
            <MessageCircle className="size-[18px]" strokeWidth={2} />
            <Repeat2 className="size-[18px]" strokeWidth={2} />
            <Heart className="size-[18px]" strokeWidth={2} />
            <ChartNoAxesColumn className="size-[18px]" strokeWidth={2} />
            <span className="flex items-center gap-3">
              <Bookmark className="size-[18px]" strokeWidth={2} />
              <Upload className="size-[18px]" strokeWidth={2} />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function LinkedInPreview({ profile, body, images, postedAt, editing }: CardProps) {
  const [expanded, setExpanded] = useState(false);
  /** Caret inside the text — never clamp out from under it. */
  const [focused, setFocused] = useState(false);
  // The real trigger is 3 rendered lines; chars + explicit newlines is a
  // faithful-enough stand-in for a fixed-width preview card.
  const needsClamp =
    !expanded && !focused && (body.length > 210 || body.split("\n").length > 3);
  return (
    <div
      className="rounded-lg border border-[#e0dfdc] bg-white pb-1"
      style={{ fontFamily: SYSTEM_FONT }}
    >
      <div className="flex items-start gap-2.5 px-4 pt-3">
        <Avatar profile={profile} size="size-12" />
        <div className="min-w-0 pt-0.5">
          <div className="text-[14px] font-semibold leading-tight text-[#191919]">
            {profile.name || "Your Name"}
          </div>
          <div className="truncate text-[12px] leading-tight text-[#666]">
            {profile.bio || "Your headline"}
          </div>
          <div className="flex items-center gap-1 pt-0.5 text-[12px] leading-tight text-[#666]">
            {shortTime(postedAt)} ·
            <Earth className="size-3" strokeWidth={2} />
          </div>
        </div>
      </div>
      <div className="px-4 pt-2.5">
        {editing ? (
          <EditableText
            value={body}
            editing={editing}
            onEditingChange={setFocused}
            className={cn(
              "text-[14px] leading-[1.4] text-[#191919]",
              needsClamp && "line-clamp-3",
            )}
          />
        ) : (
          <div
            className={cn(
              "whitespace-pre-wrap break-words text-[14px] leading-[1.4] text-[#191919]",
              needsClamp && "line-clamp-3",
            )}
          >
            {richText(body, "#0a66c2")}
          </div>
        )}
        {needsClamp ? (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="text-[14px] text-[#666] hover:text-[#0a66c2] hover:underline"
          >
            …more
          </button>
        ) : null}
        {/* The real LinkedIn feed has no collapse — this exists so checking
            the truncated view doesn't require deselecting the post. */}
        {expanded ? (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="block pt-1 text-[13px] text-[#666] hover:text-[#0a66c2] hover:underline"
          >
            see less
          </button>
        ) : null}
      </div>
      <LinkedInImages images={images} />
      <div className="mx-3 mt-1 flex items-center justify-around border-t border-[#e0dfdc] pt-0.5">
        {[
          { icon: ThumbsUp, label: "Like" },
          { icon: MessageCircle, label: "Comment" },
          { icon: Repeat2, label: "Repost" },
          { icon: Send, label: "Send" },
        ].map(({ icon: Icon, label }) => (
          <span
            key={label}
            className="flex items-center gap-1.5 rounded px-3 py-2.5 text-[13px] font-semibold text-[#666]"
          >
            <Icon className="size-4" strokeWidth={2} />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

const IG_CAPTION_PREVIEW = 125;

function InstagramPreview({ profile, body, images, postedAt, editing }: CardProps) {
  const [expanded, setExpanded] = useState(false);
  const [focused, setFocused] = useState(false);
  const [index, setIndex] = useState(0);
  const handle = profile.handle || "yourhandle";
  const shown =
    expanded || body.length <= IG_CAPTION_PREVIEW
      ? body
      : `${body.slice(0, IG_CAPTION_PREVIEW).trimEnd()}`;
  const truncated = shown.length < body.length;
  const img = images[Math.min(index, Math.max(images.length - 1, 0))];

  return (
    <div
      className="overflow-hidden rounded-lg border border-[#dbdbdb] bg-white"
      style={{ fontFamily: SYSTEM_FONT }}
    >
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <Avatar profile={profile} size="size-8" />
        <span className="text-[14px] font-semibold text-[#262626]">{handle}</span>
        <span className="text-[14px] text-[#8e8e8e]">
          • {shortTime(postedAt)}
        </span>
      </div>
      {images.length > 0 ? (
        <div className="relative aspect-square bg-black">
          {/* eslint-disable-next-line @next/next/no-img-element -- app-served blob */}
          <img src={img.url} alt="" className="h-full w-full object-cover" />
          {images.length > 1 ? (
            <>
              <span className="absolute right-2 top-2 rounded-full bg-black/70 px-2 py-0.5 text-[11px] font-medium text-white">
                {index + 1}/{images.length}
              </span>
              {index > 0 ? (
                <button
                  type="button"
                  aria-label="Previous image"
                  onClick={() => setIndex((i) => i - 1)}
                  className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-white/90 p-0.5"
                >
                  <ChevronLeft className="size-4 text-[#262626]" />
                </button>
              ) : null}
              {index < images.length - 1 ? (
                <button
                  type="button"
                  aria-label="Next image"
                  onClick={() => setIndex((i) => i + 1)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-white/90 p-0.5"
                >
                  <ChevronRight className="size-4 text-[#262626]" />
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : (
        <div className="flex aspect-square flex-col items-center justify-center gap-2 bg-[#fafafa] text-[#8e8e8e]">
          <ImageIcon className="size-8" strokeWidth={1.5} />
          <span className="px-8 text-center text-[12px]">
            Instagram posts need an image — add one below the editor
          </span>
        </div>
      )}
      <div className="flex items-center gap-4 px-3 pt-2.5 text-[#262626]">
        <Heart className="size-6" strokeWidth={1.8} />
        <MessageCircle className="size-6 -scale-x-100" strokeWidth={1.8} />
        <Send className="size-6" strokeWidth={1.8} />
        <Bookmark className="ml-auto size-6" strokeWidth={1.8} />
      </div>
      {images.length > 1 ? (
        <div className="flex justify-center gap-1 pt-2">
          {images.map((im, i) => (
            <span
              key={im.url}
              className={cn(
                "size-1.5 rounded-full",
                i === index ? "bg-[#0095f6]" : "bg-[#dbdbdb]",
              )}
            />
          ))}
        </div>
      ) : null}
      <div className="px-3 pb-3 pt-2">
        {editing ? (
          <>
            <div
              className={cn(
                "text-[14px] leading-[18px] text-[#262626]",
                // Slice-truncation can't apply to an editable node, so the
                // editor approximates the 125-char cut as a 2-line clamp.
                !focused &&
                  !expanded &&
                  body.length > IG_CAPTION_PREVIEW &&
                  "line-clamp-2",
              )}
            >
              <span className="font-semibold">{handle}</span>{" "}
              <EditableText
                inline
                value={body}
                editing={editing}
                onEditingChange={setFocused}
              />
            </div>
            {body.length > IG_CAPTION_PREVIEW ? (
              <button
                type="button"
                onClick={() => setExpanded((e) => !e)}
                className="text-[13px] text-[#8e8e8e]"
              >
                {expanded ? "less" : "… more"}
              </button>
            ) : null}
          </>
        ) : body ? (
          <div className="text-[14px] leading-[18px] text-[#262626]">
            <span className="font-semibold">{handle}</span>{" "}
            <span className="whitespace-pre-wrap break-words">
              {richText(shown, "#00376b")}
            </span>
            {truncated ? (
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="text-[#8e8e8e]"
              >
                … more
              </button>
            ) : null}
            {expanded && body.length > IG_CAPTION_PREVIEW ? (
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="pl-1 text-[#8e8e8e]"
              >
                less
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="pt-1.5 text-[10px] uppercase tracking-wide text-[#8e8e8e]">
          {postedAt ? shortTime(postedAt) : "Just now"}
        </div>
      </div>
    </div>
  );
}

export function SocialPostPreview({
  platform,
  profiles,
  body,
  images,
  postedAt,
  editing,
}: {
  platform: SocialPostPlatform;
  profiles: PreviewProfiles;
  body: string;
  images: PreviewImage[];
  postedAt: string | null;
  /** Pass to make the preview's text region the editor. */
  editing?: PreviewEditing;
}) {
  // Keyed per platform so expansion/carousel/caret state doesn't leak
  // between renderings of the same draft.
  const props = { profile: profiles[platform], body, images, postedAt, editing };
  if (platform === "x") return <XPreview key="x" {...props} />;
  if (platform === "linkedin") return <LinkedInPreview key="li" {...props} />;
  return <InstagramPreview key="ig" {...props} />;
}
