"use client";

import { useCallback, useState } from "react";
import { Mail, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { displayName } from "@/lib/format";
import { PersonAvatar } from "@/components/person-avatar";
import { PersonDetail } from "@/components/person-detail";
import type { GroupWithCount } from "@/components/app-shell";
import type { OpenDraft } from "@/lib/actions/drafts";

/**
 * lucide-react ships no LinkedIn glyph (brand icons were removed), so the "in"
 * square is hand-rolled — same as person-timeline-tab.tsx and person-detail.tsx.
 */
function ChannelIcon({ channel }: { channel: OpenDraft["channel"] }) {
  if (channel === "email")
    return <Mail className="size-3.5 text-muted-foreground" />;
  if (channel === "sms")
    return <MessageSquare className="size-3.5 text-muted-foreground" />;
  return (
    <span className="flex size-3.5 items-center justify-center rounded-[3px] bg-[#0a66c2] text-[7px] font-bold text-white">
      in
    </span>
  );
}

export function DraftsView({
  drafts,
  groups,
  initialPersonId,
}: {
  drafts: OpenDraft[];
  groups: GroupWithCount[];
  initialPersonId?: number;
}) {
  const [selectedId, setSelectedId] = useState<number | null>(
    initialPersonId ?? null,
  );

  // Keep the URL in step so a refresh or back-button lands on the same person,
  // mirroring people-view: push on mobile (the overlay is a screen you back out
  // of), replace on desktop (the pane is part of the same screen).
  const select = useCallback((id: number | null) => {
    setSelectedId(id);
    const url = new URL(window.location.href);
    if (id === null) url.searchParams.delete("person");
    else url.searchParams.set("person", String(id));
    const isMobile = window.matchMedia("(max-width: 1023px)").matches;
    if (id !== null && isMobile) {
      window.history.pushState(null, "", url);
    } else {
      window.history.replaceState(null, "", url);
    }
  }, []);

  return (
    <div className="flex h-full min-h-0 bg-muted md:p-0">
      {/* List pane */}
      <section className="flex min-w-0 flex-1 flex-col border-border bg-background md:m-0 md:border-r">
        <div className="border-b border-border px-5 pb-2.5 pt-3">
          <h1 className="text-[15px] font-semibold text-foreground">Drafts</h1>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pb-10">
          {drafts.length === 0 ? (
            <div className="px-6 pt-16 text-center text-[13.5px] text-muted-foreground">
              No drafts. Open a person and use the pen icon to write one.
            </div>
          ) : (
            drafts.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => select(d.contactId)}
                className={cn(
                  "flex w-full items-center gap-3 px-5 py-3 text-left transition-colors",
                  d.contactId === selectedId
                    ? "bg-muted"
                    : "hover:bg-muted/60",
                )}
              >
                <PersonAvatar
                  name={d.contactName}
                  photoSrc={d.hasPhoto ? `/api/photos/${d.contactId}` : null}
                  className="size-8"
                />
                <span className="w-32 shrink-0 truncate text-[14.5px] font-semibold text-foreground sm:w-44">
                  {displayName(d.contactName)}
                </span>
                <div className="min-w-0 flex-1">
                  {d.subject ? (
                    <div className="truncate text-[13.5px] text-foreground">
                      {d.subject}
                    </div>
                  ) : null}
                  <div className="truncate text-[13.5px] text-muted-foreground">
                    {d.body}
                  </div>
                </div>
                <ChannelIcon channel={d.channel} />
              </button>
            ))
          )}
        </div>
      </section>

      {/* Detail pane — desktop */}
      <aside className="hidden w-[400px] shrink-0 bg-background lg:block xl:w-[430px]">
        {selectedId ? (
          <PersonDetail
            key={selectedId}
            personId={selectedId}
            row={null}
            groups={groups}
            onClose={() => select(null)}
            clearFloatingMenu={false}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-8 text-center text-[13.5px] text-muted-foreground">
            Select a draft to see the person
          </div>
        )}
      </aside>

      {/* Detail — mobile overlay */}
      {selectedId ? (
        <div className="fixed inset-0 z-40 bg-background pt-[env(safe-area-inset-top)] lg:hidden">
          <PersonDetail
            key={`m-${selectedId}`}
            personId={selectedId}
            row={null}
            groups={groups}
            onClose={() => select(null)}
            clearFloatingMenu={false}
          />
        </div>
      ) : null}
    </div>
  );
}
