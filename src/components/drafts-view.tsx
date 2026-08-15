"use client";

import { useCallback, useState } from "react";
import { Clock, Mail, MessageSquare, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { ago, displayName, roleLine } from "@/lib/format";
import { PersonAvatar } from "@/components/person-avatar";
import { PersonDetail } from "@/components/person-detail";
import { useShell, type GroupWithCount } from "@/components/app-shell";
import type { OpenDraft } from "@/lib/actions/drafts";
import type { PersonRow } from "@/lib/actions/contacts";

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
  suggestions,
  initialPersonId,
}: {
  drafts: OpenDraft[];
  groups: GroupWithCount[];
  /** People overdue for a reconnect — same rule as Home's own list. */
  suggestions: PersonRow[];
  initialPersonId?: number;
}) {
  const { aiEnabled } = useShell();
  const [selectedId, setSelectedId] = useState<number | null>(
    initialPersonId ?? null,
  );
  /**
   * Set alongside `selectedId` when a suggestion card's "Draft with AI" button
   * is clicked, never by a plain row click. PersonDetail remounts per contact
   * (keyed below), so it only needs to be true at the moment that instance
   * mounts — no need to clear it afterward.
   */
  const [autoDraftId, setAutoDraftId] = useState<number | null>(null);
  /**
   * The desktop `<aside>` and the mobile overlay both mount PersonDetail
   * unconditionally — CSS just hides whichever one the viewport doesn't show.
   * Without this, autoDraft would fire generate() in BOTH instances at once,
   * which is a real cost bug (not a dev-only artifact) for something that
   * calls a paid LLM. Snapshotting which layout is active at click time keeps
   * exactly one instance armed.
   */
  const [autoDraftLayout, setAutoDraftLayout] = useState<
    "desktop" | "mobile" | null
  >(null);

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

  function selectAndDraft(id: number) {
    const isMobile = window.matchMedia("(max-width: 1023px)").matches;
    setAutoDraftLayout(isMobile ? "mobile" : "desktop");
    setAutoDraftId(id);
    select(id);
  }

  return (
    <div className="flex h-full min-h-0 bg-muted md:p-0">
      {/* List pane */}
      <section
        className={cn(
          "flex min-w-0 flex-1 flex-col border-border bg-background md:m-0",
          selectedId && "lg:border-r",
        )}
      >
        <div className="border-b border-border px-5 pt-3">
          <h1 className="pb-2.5 text-[15px] font-semibold text-foreground">
            Drafts
          </h1>
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
                {d.source === "ai" ? (
                  <Sparkles
                    className="size-3.5 shrink-0 text-violet-500"
                    aria-label="Drafted with AI"
                  />
                ) : null}
                <ChannelIcon channel={d.channel} />
              </button>
            ))
          )}

          <ReconnectSuggestions
            people={suggestions}
            aiEnabled={aiEnabled}
            selectedId={selectedId}
            onSelect={select}
            onDraft={selectAndDraft}
          />
        </div>
      </section>

      {/* Detail pane — desktop. Not rendered at all when nothing is selected,
          so the list stretches the full width instead of sitting next to an
          empty "select a draft" pane. */}
      {selectedId ? (
        <aside className="hidden w-[400px] shrink-0 bg-background lg:block xl:w-[430px]">
          <PersonDetail
            key={selectedId}
            personId={selectedId}
            row={null}
            groups={groups}
            onClose={() => select(null)}
            autoDraft={autoDraftId === selectedId && autoDraftLayout === "desktop"}
          />
        </aside>
      ) : null}

      {/* Detail — mobile overlay */}
      {selectedId ? (
        <div className="fixed inset-0 z-40 bg-background pt-[env(safe-area-inset-top)] lg:hidden">
          <PersonDetail
            key={`m-${selectedId}`}
            personId={selectedId}
            row={null}
            groups={groups}
            onClose={() => select(null)}
            autoDraft={autoDraftId === selectedId && autoDraftLayout === "mobile"}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * People overdue for a reconnect, in the white space below the drafts list.
 * Same list Home's "Haven't talked in a while" shows — see lib/reconnect.ts.
 * The AI button is hidden without a key, same gate as the composer's own
 * sparkle button; the card itself still works as a plain "open this person"
 * shortcut either way.
 */
function ReconnectSuggestions({
  people,
  aiEnabled,
  selectedId,
  onSelect,
  onDraft,
}: {
  people: PersonRow[];
  aiEnabled: boolean;
  selectedId: number | null;
  onSelect: (id: number) => void;
  onDraft: (id: number) => void;
}) {
  if (people.length === 0) return null;

  return (
    <div className="pt-2">
      <div className="flex items-center gap-2 px-5 pb-1.5 pt-4">
        <Clock className="size-3.5 text-muted-foreground" />
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          People to reach out to
        </h2>
      </div>
      <div className="flex flex-col gap-2 px-5 pb-6">
        {people.map((p) => (
          <div
            key={p.id}
            className={cn(
              "rounded-lg border p-2.5 transition-colors",
              p.id === selectedId
                ? "border-violet-200 bg-violet-50/60"
                : "border-border",
            )}
          >
            <button
              type="button"
              onClick={() => onSelect(p.id)}
              className="flex w-full items-center gap-3 rounded-md text-left"
            >
              <PersonAvatar
                name={p.fullName}
                photoSrc={p.hasPhoto ? `/api/photos/${p.id}` : null}
                className="size-9"
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] font-semibold text-foreground">
                  {displayName(p.fullName)}
                </div>
                <div className="truncate text-[12px] text-muted-foreground">
                  {roleLine(p.title, p.company) ?? "No role on file"}
                </div>
              </div>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {ago(p.lastInteractionDate)}
              </span>
            </button>
            {aiEnabled ? (
              <button
                type="button"
                onClick={() => onDraft(p.id)}
                className="mt-2 flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] font-medium text-violet-600 transition-colors hover:bg-violet-100"
              >
                <Sparkles className="size-3.5" />
                Draft with AI
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
