"use client";

import { useEffect, useState, useTransition } from "react";
import {
  ArrowLeft,
  ExternalLink,
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
  type ContactDetail,
  type PersonRow,
} from "@/lib/actions/contacts";
import { ensureGeocoded } from "@/lib/actions/geocode";
import type { GroupWithCount } from "@/components/app-shell";
import { PersonAvatar } from "@/components/person-avatar";
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
}: {
  personId: number;
  row: PersonRow | null;
  groups: GroupWithCount[];
  onClose: () => void;
}) {
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
  const displayName = c?.fullName ?? row?.fullName ?? "";
  const hasPhoto = detail?.hasPhoto ?? row?.hasPhoto ?? false;

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

  return (
    <div className="flex h-full flex-col overflow-y-auto overscroll-contain">
      {/* Top bar */}
      {/* pr-12 on desktop keeps these controls clear of the floating activity menu */}
      <div className="sticky top-0 z-10 flex items-center gap-1 bg-white/90 px-3 py-2 backdrop-blur md:pr-12">
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label="Back"
          className="text-stone-500"
        >
          <ArrowLeft className="size-5" />
        </Button>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleStar}
            aria-label="Star"
            className="text-stone-400"
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
                  className="text-stone-400"
                  aria-label="More options"
                >
                  <MoreHorizontal className="size-[18px]" />
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              {c?.linkedinUrl ? (
                <DropdownMenuItem
                  onClick={() => window.open(c.linkedinUrl!, "_blank")}
                >
                  <ExternalLink className="size-4" /> Open LinkedIn
                </DropdownMenuItem>
              ) : null}
              {c?.meshUrl ? (
                <DropdownMenuItem
                  onClick={() => window.open(c.meshUrl!, "_blank")}
                >
                  <ExternalLink className="size-4" /> Open in Mesh
                </DropdownMenuItem>
              ) : null}
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
        <PersonAvatar
          name={displayName || "?"}
          photoSrc={hasPhoto ? `/api/photos/${personId}` : null}
          className="size-24"
          textClass="text-[28px]"
        />
        <div className="flex items-center gap-1.5 pt-1">
          <h2 className="text-[21px] font-semibold leading-tight text-stone-900">
            {displayName}
          </h2>
          {c && c.source !== "manual" ? (
            <span className="rounded bg-stone-200/70 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-stone-500">
              Auto
            </span>
          ) : null}
        </div>
        {c?.title || c?.company ? (
          <p className="text-[13.5px] text-stone-500">
            {[c?.title, c?.company].filter(Boolean).join(" · ")}
          </p>
        ) : null}
        {c?.location ? (
          <p className="text-[12px] uppercase tracking-wide text-stone-400">
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
            <PersonTimelineTab detail={detail} setDetail={setDetail} />
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
      className="flex size-9 items-center justify-center rounded-full bg-stone-100 text-stone-600 transition-colors hover:bg-stone-200"
    >
      {children}
    </button>
  );
}
