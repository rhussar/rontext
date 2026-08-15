"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Mail,
  MoreHorizontal,
  Phone,
  Star,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  getContactDetail,
  setArchived,
  setStarred,
  updateContact,
  type ContactDetail,
  type PersonRow,
} from "@/lib/actions/contacts";
import {
  importContactPhotoFromUrl,
  removeContactPhoto,
  uploadContactPhoto,
} from "@/lib/actions/photos";
import { ensureGeocoded } from "@/lib/actions/geocode";
import type { ClipboardImage } from "@/lib/clipboard-image";
import { displayName as formatContactName } from "@/lib/format";
import type { GroupWithCount } from "@/components/app-shell";
import { MergeDialog } from "@/components/merge-dialog";
import { MergeSearchDialog } from "@/components/merge-search-dialog";
import { PhotoPicker } from "@/components/photo-picker";
import { PersonAboutTab } from "@/components/person-about-tab";
import { PersonTimelineTab } from "@/components/person-timeline-tab";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function PersonDetail({
  personId,
  row,
  groups,
  onClose,
  clearFloatingMenu = true,
  autoDraft = false,
}: {
  personId: number;
  row: PersonRow | null;
  groups: GroupWithCount[];
  onClose: () => void;
  /**
   * Reserve room for the floating alerts bell that overlaps this pane's
   * top-right in the People view. The Network panel sits below that bell,
   * so it turns this off and lets the controls hug the right edge.
   */
  clearFloatingMenu?: boolean;
  /**
   * Jump straight into a generation, for the "Draft with AI" button on
   * Drafts' reconnect-suggestion cards. Safe as a one-shot: this component
   * remounts per contact (callers key it by personId), so there's no risk of
   * re-firing on an unrelated re-render.
   */
  autoDraft?: boolean;
}) {
  const router = useRouter();
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

  // Resolve coordinates in the background, once per contact. The delay means
  // clicking quickly down the list doesn't fire lookups for people you skipped
  // past — this component remounts per person, so the timer gets cancelled.
  const contactId = detail?.contact.id;
  const location = detail?.contact.location;
  const geocodedAt = detail?.contact.geocodedAt;
  useEffect(() => {
    if (!contactId || !location?.trim() || geocodedAt) return;
    const timer = setTimeout(() => {
      ensureGeocoded(contactId).then((coords) => {
        setDetail((prev) =>
          prev && prev.contact.id === contactId
            ? {
                ...prev,
                contact: {
                  ...prev.contact,
                  latitude: coords?.latitude ?? null,
                  longitude: coords?.longitude ?? null,
                  geocodedAt: new Date(),
                },
              }
            : prev,
        );
      });
    }, 400);
    return () => clearTimeout(timer);
  }, [contactId, location, geocodedAt]);

  const c = detail?.contact;
  const displayName = formatContactName(c?.fullName ?? row?.fullName ?? "");

  // Photo edits land here before the server round-trip finishes, and photoV
  // busts the browser cache — /api/photos/<id> is the same URL after a
  // replacement, so without it the old face stays on screen.
  const [photoOverride, setPhotoOverride] = useState<boolean | null>(null);
  const [photoV, setPhotoV] = useState(0);
  const [photoBusy, startPhoto] = useTransition();
  useEffect(() => {
    setPhotoOverride(null);
    setPhotoV(0);
  }, [personId]);

  const hasPhoto =
    photoOverride ?? detail?.hasPhoto ?? row?.hasPhoto ?? false;
  const photoSrc = hasPhoto
    ? `/api/photos/${personId}${photoV ? `?v=${photoV}` : ""}`
    : null;

  function pickPhoto(image: ClipboardImage) {
    startPhoto(async () => {
      let result;
      if (image.kind === "file") {
        const fd = new FormData();
        fd.set("file", image.file);
        result = await uploadContactPhoto(personId, fd);
      } else {
        result = await importContactPhotoFromUrl(personId, image.url);
      }
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setPhotoOverride(true);
      setPhotoV(Date.now());
      toast.success("Photo updated");
    });
  }

  function dropPhoto() {
    startPhoto(async () => {
      await removeContactPhoto(personId);
      setPhotoOverride(false);
      setPhotoV(0);
      toast.success("Photo removed");
    });
  }

  const [editingName, setEditingName] = useState(false);
  useEffect(() => setEditingName(false), [personId]);

  /** The header edits one visible name; updateContact re-joins fullName. */
  function saveName(next: string) {
    setEditingName(false);
    const trimmed = next.trim();
    if (!detail || !trimmed || trimmed === displayName) return;
    const [first, ...rest] = trimmed.split(/\s+/);
    const patch = { firstName: first, lastName: rest.join(" ") || null };
    setDetail({
      ...detail,
      contact: { ...detail.contact, ...patch, fullName: trimmed },
    });
    updateContact(personId, patch).catch(() => toast.error("Couldn't save"));
  }

  function toggleStar() {
    if (!detail) return;
    const next = !detail.contact.starred;
    setDetail({ ...detail, contact: { ...detail.contact, starred: next } });
    startTransition(() => setStarred(personId, next));
  }

  function archive(archived: boolean) {
    startTransition(async () => {
      await setArchived(personId, archived);
      toast.success(
        archived ? `${displayName} archived` : `${displayName} restored`,
      );
      if (archived) onClose();
    });
  }

  // `row` is null from callers (e.g. Drafts) that never loaded a PersonRow
  // list — fall back to a row built from `detail` so merge still works there.
  const mergeSourceRow: PersonRow | null =
    row ??
    (c
      ? {
          id: c.id,
          fullName: c.fullName,
          firstName: c.firstName,
          lastName: c.lastName,
          company: c.company,
          title: c.title,
          starred: c.starred,
          hasLinkedin: !!c.linkedinUrl,
          hasNotes: (detail?.notes.length ?? 0) > 0,
          hasPhoto,
          groupIds: [],
          archived: !!c.archivedAt,
          createdAt: c.createdAt.toISOString(),
          lastInteractionDate: c.lastInteractionDate,
          birthday: c.birthday,
        }
      : null);

  const [mergeSearchOpen, setMergeSearchOpen] = useState(false);
  const [mergeTarget, setMergeTarget] = useState<PersonRow | null>(null);

  function handleMerged(keeperId: number) {
    setMergeTarget(null);
    router.refresh();
    if (keeperId === personId) {
      getContactDetail(personId).then(setDetail);
    } else {
      // This profile was the one deleted — nothing left to show.
      onClose();
    }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto overscroll-contain">
      {/* Top bar */}
      {/* pr-12 on desktop keeps these controls clear of the floating activity menu */}
      <div
        className={cn(
          "sticky top-0 z-10 flex items-center gap-1 bg-background/90 px-3 py-2 backdrop-blur",
          clearFloatingMenu && "md:pr-12",
        )}
      >
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label="Back"
          className="text-muted-foreground"
        >
          <ArrowLeft className="size-5" />
        </Button>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleStar}
            aria-label="Star"
            className="text-muted-foreground"
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
                  className="text-muted-foreground"
                  aria-label="More options"
                >
                  <MoreHorizontal className="size-[18px]" />
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              {/* No "Open LinkedIn"/"Open in Mesh" here — the LinkedIn circle
                  under the name already covers it, and Mesh is the past. */}
              <DropdownMenuItem
                disabled={!mergeSourceRow}
                onClick={() => setMergeSearchOpen(true)}
              >
                Merge with…
              </DropdownMenuItem>
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
        </div>
      </div>

      {/* Header */}
      <div className="flex flex-col items-center gap-2 px-6 pb-5 text-center">
        <PhotoPicker
          name={displayName}
          src={photoSrc}
          onPicked={pickPhoto}
          onRemoved={dropPhoto}
          busy={photoBusy}
          className="size-24"
          textClass="text-[28px]"
        />
        <div className="flex items-center gap-1.5 pt-1">
          {editingName ? (
            <input
              autoFocus
              defaultValue={displayName}
              onBlur={(e) => saveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") setEditingName(false);
              }}
              aria-label="Name"
              className="w-full max-w-[16rem] rounded-md border border-input bg-background px-2 py-0.5 text-center text-[21px] font-semibold leading-tight text-foreground outline-none"
            />
          ) : (
            <h2
              onClick={() => c && setEditingName(true)}
              title={c ? "Click to rename" : undefined}
              className={cn(
                "rounded-md px-2 py-0.5 text-[21px] font-semibold leading-tight text-foreground",
                c && "cursor-text hover:bg-muted",
              )}
            >
              {displayName}
            </h2>
          )}
          {c && c.source !== "manual" ? (
            <span className="rounded bg-muted-foreground/20 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-muted-foreground">
              Auto
            </span>
          ) : null}
        </div>
        {c?.title || c?.company ? (
          <p className="text-[13.5px] text-muted-foreground">
            {[c?.title, c?.company].filter(Boolean).join(" · ")}
          </p>
        ) : null}
        {c?.location ? (
          <p className="text-[12px] uppercase tracking-wide text-muted-foreground">
            {c.location}
          </p>
        ) : null}

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
                onClick={() =>
                  window.open(`tel:${c.phoneNumbers[0].replace(/[^+\d]/g, "")}`)
                }
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
        <Tabs defaultValue="timeline">
          <TabsList className="mx-6 mb-3">
            <TabsTrigger value="timeline">Timeline</TabsTrigger>
            <TabsTrigger value="about">About</TabsTrigger>
          </TabsList>
          <TabsContent value="timeline">
            <PersonTimelineTab
              detail={detail}
              setDetail={setDetail}
              autoDraft={autoDraft}
            />
          </TabsContent>
          <TabsContent value="about">
            <PersonAboutTab
              detail={detail}
              setDetail={setDetail}
              groups={groups}
            />
          </TabsContent>
        </Tabs>
      )}

      <MergeSearchDialog
        excludeId={personId}
        open={mergeSearchOpen}
        onOpenChange={setMergeSearchOpen}
        onPick={setMergeTarget}
      />
      {mergeSourceRow && mergeTarget ? (
        <MergeDialog
          a={mergeSourceRow}
          b={mergeTarget}
          open
          onOpenChange={(o) => {
            if (!o) setMergeTarget(null);
          }}
          onMerged={handleMerged}
        />
      ) : null}
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
      className="flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground transition-colors hover:bg-muted-foreground/20"
    >
      {children}
    </button>
  );
}
