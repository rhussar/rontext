"use client";

import { useCallback, useMemo, useRef, useState, useTransition } from "react";
import {
  ExternalLink,
  ImageIcon,
  ImagePlus,
  Plus,
  Send,
  Sparkles,
  Trash2,
  X as XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { ago } from "@/lib/format";
import { copyText } from "@/lib/clipboard-text";
import {
  buildPostHandoff,
  platformCharCount,
  PLATFORM_LABELS,
} from "@/lib/social";
import {
  addSocialPostMedia,
  createSocialPost,
  deleteSocialPost,
  generateSocialPostAction,
  markPosted,
  postToXAction,
  removeSocialPostMedia,
  unmarkPosted,
  updateSocialPost,
  type GithubTrafficDay,
  type PlatformSnapshot,
  type PostMediaRef,
  type PostOrigin,
  type SocialPostRow,
  type TrackedPost,
} from "@/lib/actions/social";
import { downscaleImage, type DownscaledImage } from "@/lib/image-downscale";
import {
  SocialPostPreview,
  type PreviewImage,
  type PreviewProfiles,
} from "@/components/social-post-preview";
import type { SocialPlatform, SocialPostPlatform } from "@/db/schema";
import { Sparkline } from "@/components/sparkline";
import { useShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";

/**
 * lucide-react ships no brand glyphs (they were removed), so every mark here
 * is a hand-rolled square — same treatment as the "in" square in
 * drafts-view.tsx, extended to the other platforms.
 */
export function PlatformMark({
  platform,
  className,
}: {
  platform: SocialPlatform;
  className?: string;
}) {
  const base =
    "flex items-center justify-center rounded-[3px] font-bold text-white";
  if (platform === "linkedin")
    return (
      <span className={cn(base, "bg-[#0a66c2] text-[7px]", className)}>in</span>
    );
  if (platform === "x")
    return (
      <span className={cn(base, "bg-black text-[8px] dark:bg-white dark:text-black", className)}>
        𝕏
      </span>
    );
  if (platform === "instagram")
    return (
      <span
        className={cn(base, "text-[7px]", className)}
        style={{
          background:
            "radial-gradient(circle at 30% 110%, #fdf497 0%, #fd5949 45%, #d6249f 60%, #285aeb 90%)",
        }}
      >
        Ig
      </span>
    );
  return (
    <span className={cn(base, "bg-[#24292f] text-[7px] dark:bg-[#f0f6fc] dark:text-[#24292f]", className)}>
      GH
    </span>
  );
}

const POST_PLATFORMS: SocialPostPlatform[] = ["linkedin", "x", "instagram"];

type Selection = number | "new" | null;

export function SocialView({
  posts,
  overview,
  tracked,
  githubTraffic,
  profiles,
  initialPostId,
}: {
  posts: SocialPostRow[];
  overview: PlatformSnapshot[];
  tracked: TrackedPost[];
  githubTraffic: GithubTrafficDay[];
  profiles: PreviewProfiles;
  initialPostId?: number;
}) {
  const [selected, setSelected] = useState<Selection>(initialPostId ?? null);

  // Same URL discipline as drafts-view: push on mobile (the overlay is a
  // screen you back out of), replace on desktop. "new" never lands in the URL.
  const select = useCallback((sel: Selection) => {
    setSelected(sel);
    const url = new URL(window.location.href);
    if (typeof sel === "number") url.searchParams.set("post", String(sel));
    else url.searchParams.delete("post");
    const isMobile = window.matchMedia("(max-width: 1023px)").matches;
    if (sel !== null && isMobile) {
      window.history.pushState(null, "", url);
    } else {
      window.history.replaceState(null, "", url);
    }
  }, []);

  const selectedPost =
    typeof selected === "number"
      ? (posts.find((p) => p.id === selected) ?? null)
      : null;

  const open = posts.filter((p) => p.postedAt === null);
  const posted = posts.filter((p) => p.postedAt !== null);

  const detail =
    selected === "new" ? (
      <PostComposer key="new" post={null} profiles={profiles} onDone={() => select(null)} />
    ) : selectedPost ? (
      <PostComposer
        key={selectedPost.id}
        post={selectedPost}
        profiles={profiles}
        tracked={tracked.find(
          (t) => t.postUrl === selectedPost.postUrl && selectedPost.postUrl,
        )}
        onDone={() => select(null)}
      />
    ) : null;

  return (
    <div className="flex h-full min-h-0 bg-muted md:p-0">
      {/* List pane */}
      <section
        className={cn(
          "flex min-w-0 flex-1 flex-col border-border bg-background md:m-0",
          detail && "lg:border-r",
        )}
      >
        <div className="flex items-center justify-between border-b border-border px-5 pt-3">
          <h1 className="pb-2.5 text-[15px] font-semibold text-foreground">
            Social
          </h1>
          <Button
            variant="ghost"
            size="sm"
            className="mb-1.5 gap-1 text-[13px]"
            onClick={() => select("new")}
          >
            <Plus className="size-4" />
            New post
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto pb-10">
          {/* Platform tiles */}
          <div className="grid grid-cols-2 gap-2 px-5 pb-2 pt-4 xl:grid-cols-4">
            {overview.map((snap) => (
              <PlatformTile
                key={snap.platform}
                snap={snap}
                githubTraffic={
                  snap.platform === "github" ? githubTraffic : undefined
                }
              />
            ))}
          </div>

          <PostSection
            title="Drafts"
            posts={open}
            selectedId={typeof selected === "number" ? selected : null}
            onSelect={select}
            emptyCopy="No drafts. Hit “New post” to write one."
          />
          {posted.length > 0 ? (
            <PostSection
              title="Posted"
              posts={posted}
              selectedId={typeof selected === "number" ? selected : null}
              onSelect={select}
            />
          ) : null}

          <TrackedPosts tracked={tracked} posts={posts} onSelect={select} />
        </div>
      </section>

      {/* Detail pane — desktop. Not rendered at all when nothing is selected,
          so the list stretches the full width instead of sitting next to an
          empty "select a post" pane. */}
      {detail ? (
        <aside className="hidden w-[400px] shrink-0 bg-background lg:block xl:w-[430px]">
          {detail}
        </aside>
      ) : null}

      {/* Detail — mobile overlay */}
      {detail ? (
        <div className="fixed inset-0 z-40 bg-background pt-[env(safe-area-inset-top)] lg:hidden">
          {detail}
        </div>
      ) : null}
    </div>
  );
}

function delta(latest: number | null, previous: number | null): number | null {
  if (latest === null || previous === null) return null;
  return latest - previous;
}

function PlatformTile({
  snap,
  githubTraffic,
}: {
  snap: PlatformSnapshot;
  githubTraffic?: GithubTrafficDay[];
}) {
  const followers = snap.latest?.followers ?? null;
  const d = delta(followers, snap.previous?.followers ?? null);
  const isGithub = snap.platform === "github";
  const stars = isGithub ? (snap.latest?.extra?.totalStars ?? null) : null;
  const hasTraffic = isGithub && (githubTraffic?.length ?? 0) >= 2;
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center gap-1.5">
        <PlatformMark platform={snap.platform} className="size-3.5" />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {isGithub ? "GitHub" : PLATFORM_LABELS[snap.platform as SocialPostPlatform]}
        </span>
      </div>
      {snap.latest ? (
        <>
          <div className="mt-1.5 flex items-baseline gap-1.5">
            <span className="text-[19px] font-semibold text-foreground">
              {followers !== null ? followers.toLocaleString() : "—"}
            </span>
            <span className="text-[11px] text-muted-foreground">followers</span>
            {stars !== null ? (
              <span className="text-[11px] text-muted-foreground">
                · {stars.toLocaleString()} ★
              </span>
            ) : null}
            {d !== null && d !== 0 ? (
              <span
                className={cn(
                  "ml-auto text-[11px] font-medium",
                  d > 0 ? "text-emerald-600" : "text-rose-500",
                )}
              >
                {d > 0 ? "+" : ""}
                {d.toLocaleString()}
              </span>
            ) : null}
          </div>
          {/* GitHub's sparkline is repo views/day — follower counts barely
              move, traffic is the number worth watching there. */}
          {hasTraffic ? (
            <Sparkline
              values={githubTraffic!.map((p) => p.views)}
              className="mt-1.5 h-7 w-full text-violet-500"
            />
          ) : (
            <Sparkline
              values={snap.series.map((p) => p.followers)}
              className="mt-1.5 h-7 w-full text-violet-500"
            />
          )}
          <div className="mt-1 text-[10.5px] text-muted-foreground">
            {hasTraffic ? "repo views · " : ""}
            {ago(snap.latest.capturedAt)}
          </div>
        </>
      ) : (
        <div className="mt-2 text-[12px] leading-snug text-muted-foreground">
          {isGithub
            ? "No data yet — run sync‑github with a GITHUB_TOKEN."
            : "No data yet — ask Claude Code to run social‑sync."}
        </div>
      )}
    </div>
  );
}

function PostSection({
  title,
  posts,
  selectedId,
  onSelect,
  emptyCopy,
}: {
  title: string;
  posts: SocialPostRow[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  emptyCopy?: string;
}) {
  return (
    <div className="pt-2">
      <h2 className="px-5 pb-1.5 pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
      {posts.length === 0 ? (
        emptyCopy ? (
          <div className="px-5 pb-4 text-[13px] text-muted-foreground">
            {emptyCopy}
          </div>
        ) : null
      ) : (
        posts.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onSelect(p.id)}
            className={cn(
              "flex w-full items-center gap-3 px-5 py-3 text-left transition-colors",
              p.id === selectedId ? "bg-muted" : "hover:bg-muted/60",
            )}
          >
            <PlatformMark platform={p.platform} className="size-5 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-[13.5px] text-foreground">
              {p.body || <span className="text-muted-foreground">Empty draft</span>}
            </span>
            {p.media.length > 0 ? (
              <ImageIcon
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-label={`${p.media.length} image${p.media.length > 1 ? "s" : ""}`}
              />
            ) : null}
            {p.source === "ai" ? (
              <Sparkles
                className="size-3.5 shrink-0 text-violet-500"
                aria-label="Drafted with AI"
              />
            ) : null}
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {ago(p.postedAt ?? p.updatedAt)}
            </span>
          </button>
        ))
      )}
    </div>
  );
}

/**
 * Posts the scraper knows about that this app doesn't — published straight on
 * the platform. Shown so the analytics picture is complete either way.
 */
function TrackedPosts({
  tracked,
  posts,
  onSelect,
}: {
  tracked: TrackedPost[];
  posts: SocialPostRow[];
  onSelect: (id: number) => void;
}) {
  const external = tracked.filter((t) => t.postId === null);
  if (external.length === 0) return null;
  return (
    <div className="pt-2">
      <h2 className="px-5 pb-1.5 pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Tracked elsewhere
      </h2>
      {external.map((t) => {
        const linked = posts.find((p) => p.postUrl === t.postUrl);
        return (
          <a
            key={t.postUrl}
            href={t.postUrl}
            target="_blank"
            rel="noreferrer"
            onClick={
              linked
                ? (e) => {
                    e.preventDefault();
                    onSelect(linked.id);
                  }
                : undefined
            }
            className="flex w-full items-center gap-3 px-5 py-2.5 text-left transition-colors hover:bg-muted/60"
          >
            <PlatformMark platform={t.platform} className="size-5 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
              {t.excerpt ?? t.postUrl}
            </span>
            {t.impressions !== null ? (
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {t.impressions.toLocaleString()} views
              </span>
            ) : null}
            <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
          </a>
        );
      })}
    </div>
  );
}

function PostComposer({
  post,
  profiles,
  tracked,
  onDone,
}: {
  /** Null = composing a brand-new post. */
  post: SocialPostRow | null;
  profiles: PreviewProfiles;
  tracked?: TrackedPost;
  onDone: () => void;
}) {
  const { aiEnabled, xEnabled } = useShell();
  const [platform, setPlatform] = useState<SocialPostPlatform>(
    post?.platform ?? "linkedin",
  );
  const [body, setBody] = useState(post?.body ?? "");
  const [postUrl, setPostUrl] = useState(post?.postUrl ?? "");
  /**
   * Two media pools that never mix: rows already in the DB (existing post —
   * uploads happen immediately), and picked-but-unsaved images (new post —
   * they upload right after createSocialPost returns an id to attach to).
   */
  const [savedMedia, setSavedMedia] = useState<PostMediaRef[]>(post?.media ?? []);
  const [pendingMedia, setPendingMedia] = useState<DownscaledImage[]>([]);
  const mediaFileRef = useRef<HTMLInputElement>(null);
  const mediaCount = savedMedia.length + pendingMedia.length;

  const previewImages: PreviewImage[] = [
    ...savedMedia.map((m) => ({
      url: `/api/social-media/${m.id}`,
      width: m.width,
      height: m.height,
    })),
    ...pendingMedia.map((p) => ({
      url: p.previewUrl,
      width: p.width,
      height: p.height,
    })),
  ];

  async function addImages(files: File[]) {
    for (const file of files) {
      if (savedMedia.length + pendingMedia.length >= 4) {
        toast.error("At most 4 images per post.");
        break;
      }
      const scaled = await downscaleImage(file);
      if (!scaled) {
        toast.error(`Couldn't read ${file.name}.`);
        continue;
      }
      if (post) {
        const fd = new FormData();
        fd.set("file", scaled.file);
        fd.set("width", String(scaled.width));
        fd.set("height", String(scaled.height));
        const res = await addSocialPostMedia(post.id, fd);
        URL.revokeObjectURL(scaled.previewUrl);
        if (res.ok) setSavedMedia((m) => [...m, res.media]);
        else toast.error(res.error);
      } else {
        setPendingMedia((m) => [...m, scaled]);
      }
    }
  }

  function removeSaved(id: number) {
    setSavedMedia((m) => m.filter((x) => x.id !== id));
    removeSocialPostMedia(id);
  }

  function removePending(previewUrl: string) {
    setPendingMedia((m) => {
      const hit = m.find((x) => x.previewUrl === previewUrl);
      if (hit) URL.revokeObjectURL(hit.previewUrl);
      return m.filter((x) => x.previewUrl !== previewUrl);
    });
  }
  /**
   * Un-saved provenance of the last generation, handed to createSocialPost on
   * save — the only wire the provenance model has (see drafts). Cleared when
   * the topic box is reopened, never on edit: edits are detected by comparing
   * body to generatedBody, not by state here.
   */
  const [origin, setOrigin] = useState<PostOrigin | null>(null);
  const [topicOpen, setTopicOpen] = useState(false);
  const [topic, setTopic] = useState("");
  const [generating, setGenerating] = useState(false);
  const [pending, startTransition] = useTransition();
  const isPosted = post?.postedAt != null;

  function generate() {
    if (generating || !topic.trim()) return;
    setGenerating(true);
    generateSocialPostAction(platform, topic)
      .then((res) => {
        if (res.ok) {
          setBody(res.body);
          setOrigin(res.origin);
          setTopicOpen(false);
        } else {
          toast.error(res.error);
        }
      })
      .finally(() => setGenerating(false));
  }

  const counter = useMemo(
    () => platformCharCount(platform, body),
    [platform, body],
  );
  const over = counter.count > counter.limit;

  function save() {
    const trimmed = body.trim();
    if (!trimmed) return;
    startTransition(async () => {
      if (post) {
        await updateSocialPost(post.id, { platform, body });
        toast.success("Post updated");
      } else {
        const created = await createSocialPost(platform, body, origin ?? undefined);
        // Images picked before the row existed upload now, in display order.
        for (const p of pendingMedia) {
          const fd = new FormData();
          fd.set("file", p.file);
          fd.set("width", String(p.width));
          fd.set("height", String(p.height));
          const res = await addSocialPostMedia(created.id, fd);
          URL.revokeObjectURL(p.previewUrl);
          if (!res.ok) toast.error(res.error);
        }
        toast.success("Draft saved");
        onDone();
      }
    });
  }

  function handoff() {
    const h = buildPostHandoff(platform, body);
    copyText(h.copy).then((ok) => {
      if (ok) toast.success("Copied to clipboard");
      window.open(h.url, "_blank", "noopener");
    });
  }

  function markAsPosted() {
    if (!post) return;
    startTransition(async () => {
      await markPosted(post.id, postUrl.trim() || undefined);
      toast.success("Marked as posted");
    });
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-5">
      <div className="flex items-center justify-between pb-4">
        <h2 className="text-[15px] font-semibold text-foreground">
          {post ? (isPosted ? "Posted" : "Edit draft") : "New post"}
        </h2>
        <div className="flex items-center gap-1">
          {post ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Delete post"
              className="size-8 text-muted-foreground hover:text-rose-500"
              onClick={() =>
                startTransition(async () => {
                  await deleteSocialPost(post.id);
                  toast.success("Deleted");
                  onDone();
                })
              }
            >
              <Trash2 className="size-4" />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className="text-[13px] text-muted-foreground"
            onClick={onDone}
          >
            Close
          </Button>
        </div>
      </div>

      {/* Platform segmented control */}
      <div className="flex gap-1 rounded-lg bg-muted p-1">
        {POST_PLATFORMS.map((p) => (
          <button
            key={p}
            type="button"
            disabled={isPosted}
            onClick={() => setPlatform(p)}
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-[12.5px] font-medium transition-colors",
              p === platform
                ? "bg-background text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
              isPosted && "opacity-60",
            )}
          >
            <PlatformMark platform={p} className="size-3.5" />
            {PLATFORM_LABELS[p]}
          </button>
        ))}
      </div>

      {/* AI generation — new posts only: regenerating over an existing row
          would bypass the provenance wire (updateSocialPost carries none). */}
      {!post && aiEnabled ? (
        topicOpen ? (
          <div className="mt-3 flex items-center gap-2">
            <input
              autoFocus
              type="text"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") generate();
                if (e.key === "Escape") setTopicOpen(false);
              }}
              placeholder="What should the post be about?"
              className="min-w-0 flex-1 rounded-lg border border-violet-200 bg-background px-3 py-2 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-violet-400"
            />
            <Button
              size="sm"
              disabled={generating || !topic.trim()}
              onClick={generate}
              className="gap-1.5 bg-violet-600 text-[13px] text-white hover:bg-violet-700"
            >
              <Sparkles className="size-3.5" />
              {generating ? "Writing…" : "Write"}
            </Button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              setTopicOpen(true);
              setOrigin(null);
            }}
            className="mt-3 flex items-center gap-1.5 self-start rounded-md px-1.5 py-1 text-[12.5px] font-medium text-violet-600 transition-colors hover:bg-violet-100 dark:hover:bg-violet-950"
          >
            <Sparkles className="size-3.5" />
            Draft with AI
          </button>
        )
      ) : null}

      {/* The preview IS the editor: type straight into the card's text
          region, which renders exactly as the platform's public view.
          Forced light inside, no matter the app theme. Identity (name,
          handles, photo) lives in Settings → General. */}
      <div className="pt-3">
        <SocialPostPreview
          platform={platform}
          profiles={profiles}
          body={body}
          images={previewImages}
          postedAt={post?.postedAt ?? null}
          editing={
            !isPosted
              ? {
                  onChange: setBody,
                  onSubmit: save,
                  placeholder:
                    platform === "x"
                      ? "What's happening?"
                      : platform === "linkedin"
                        ? "What do you want to talk about?"
                        : "Write a caption…",
                }
              : undefined
          }
        />
      </div>

      {!isPosted ? (
        <>
          <div
            className={cn(
              "pt-1 text-right text-[11px]",
              over ? "font-medium text-amber-600" : "text-muted-foreground",
            )}
          >
            {counter.approx ? "≈" : ""}
            {counter.count.toLocaleString()} / {counter.limit.toLocaleString()}
          </div>

          {/* Attached images */}
          <div className="flex items-center gap-2 pt-1">
            {previewImages.map((img, i) => {
              const saved = i < savedMedia.length ? savedMedia[i] : null;
              return (
                <span key={img.url} className="group/thumb relative">
                  {/* eslint-disable-next-line @next/next/no-img-element -- local blob */}
                  <img
                    src={img.url}
                    alt=""
                    className="size-14 rounded-lg border border-border object-cover"
                  />
                  <button
                    type="button"
                    aria-label="Remove image"
                    onClick={() =>
                      saved ? removeSaved(saved.id) : removePending(img.url)
                    }
                    className="absolute -right-1.5 -top-1.5 rounded-full bg-foreground p-0.5 text-background opacity-0 transition-opacity group-hover/thumb:opacity-100"
                  >
                    <XIcon className="size-3" />
                  </button>
                </span>
              );
            })}
            {mediaCount < 4 ? (
              <button
                type="button"
                onClick={() => mediaFileRef.current?.click()}
                className="flex size-14 items-center justify-center rounded-lg border border-dashed border-border text-muted-foreground transition-colors hover:border-input hover:text-foreground"
                aria-label="Add image"
                title="Add image (up to 4)"
              >
                <ImagePlus className="size-5" />
              </button>
            ) : null}
            <input
              ref={mediaFileRef}
              type="file"
              multiple
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={(e) => {
                // Snapshot BEFORE clearing: FileList is live, and resetting
                // value (to allow re-picking the same file) empties it.
                const files = Array.from(e.target.files ?? []);
                e.target.value = "";
                addImages(files);
              }}
            />
          </div>
        </>
      ) : null}

      {!isPosted ? (
        <div className="flex items-center gap-2 pt-2">
          <Button
            size="sm"
            disabled={pending || !body.trim()}
            onClick={save}
            className="text-[13px]"
          >
            {post ? "Save" : "Save draft"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!body.trim()}
            onClick={handoff}
            className="gap-1.5 text-[13px]"
          >
            <ExternalLink className="size-3.5" />
            {buildPostHandoff(platform, body || " ").label}
          </Button>
          {/* API posting exists for X only; saved drafts only, so what goes
              out is exactly what's in the row. */}
          {post && platform === "x" && xEnabled ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending || !body.trim() || over}
              onClick={() =>
                startTransition(async () => {
                  const res = await postToXAction(post.id);
                  if (res.ok) toast.success("Posted to X");
                  else toast.error(res.error);
                })
              }
              className="gap-1.5 text-[13px]"
            >
              <Send className="size-3.5" />
              Post to X
            </Button>
          ) : null}
        </div>
      ) : null}

      {post ? (
        <div className="mt-5 border-t border-border pt-4">
          <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Post URL
          </label>
          <input
            type="url"
            value={postUrl}
            onChange={(e) => setPostUrl(e.target.value)}
            placeholder="Paste the permalink after posting"
            className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-input"
          />
          <div className="flex items-center gap-2 pt-2.5">
            {isPosted ? (
              <>
                <span className="text-[12px] text-muted-foreground">
                  Posted {ago(post.postedAt!)}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto text-[12.5px] text-muted-foreground"
                  disabled={pending}
                  onClick={() =>
                    startTransition(async () => {
                      await unmarkPosted(post.id);
                      toast.success("Back to draft");
                    })
                  }
                >
                  Unmark posted
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={markAsPosted}
                className="text-[13px]"
              >
                Mark posted
              </Button>
            )}
          </div>

          {tracked ? <PostMetricsBlock tracked={tracked} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function PostMetricsBlock({ tracked }: { tracked: TrackedPost }) {
  const stats: { label: string; value: number | null }[] = [
    { label: "Impressions", value: tracked.impressions },
    { label: "Likes", value: tracked.likes },
    { label: "Comments", value: tracked.comments },
    { label: "Reposts", value: tracked.reposts },
  ];
  const known = stats.filter((s) => s.value !== null);
  if (known.length === 0) return null;
  return (
    <div className="mt-4">
      <h3 className="pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Performance
      </h3>
      <div className="grid grid-cols-2 gap-2">
        {known.map((s) => (
          <div key={s.label} className="rounded-lg bg-muted px-3 py-2">
            <div className="text-[15px] font-semibold text-foreground">
              {s.value!.toLocaleString()}
            </div>
            <div className="text-[11px] text-muted-foreground">{s.label}</div>
          </div>
        ))}
      </div>
      <div className="pt-1.5 text-[10.5px] text-muted-foreground">
        Captured {ago(tracked.capturedAt)}
      </div>
    </div>
  );
}
