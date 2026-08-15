"use client";

import { createContext, useCallback, useContext, useState } from "react";
import { cn } from "@/lib/utils";
import { PersonDetail } from "@/components/person-detail";
import type { GroupWithCount } from "@/components/app-shell";

/**
 * Home is a server component, so its rows can't take an onClick from the
 * pane owner. Instead the pane owner (HomeShell) publishes `select` through
 * context and every person row is a HomePersonLink that reads it. The rows
 * stay real <a href> links to /?person=N, so middle-click / copy-link keep
 * working and a refresh lands on the same person.
 */
const SelectContext = createContext<(id: number) => void>(() => {});

export function HomePersonLink({
  personId,
  className,
  children,
}: {
  personId: number;
  className?: string;
  children: React.ReactNode;
}) {
  const select = useContext(SelectContext);
  return (
    <a
      href={`/?person=${personId}`}
      className={className}
      onClick={(e) => {
        // Modified clicks keep native link behaviour (new tab etc.).
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        select(personId);
      }}
    >
      {children}
    </a>
  );
}

/**
 * The split-pane wrapper for Home, mirroring people-view/drafts-view: the
 * feed on the left, a person's profile on the right once one is clicked,
 * nothing on the right (and the feed at full width) otherwise.
 */
export function HomeShell({
  groups,
  initialPersonId,
  children,
}: {
  groups: GroupWithCount[];
  initialPersonId?: number;
  children: React.ReactNode;
}) {
  const [selectedId, setSelectedId] = useState<number | null>(
    initialPersonId ?? null,
  );

  // Same URL discipline as the other split views: push on mobile (the overlay
  // is a screen you back out of), replace on desktop (same screen).
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
    <SelectContext.Provider value={select}>
      <div className="flex h-full min-h-0 bg-muted">
        <section
          className={cn(
            "flex min-w-0 flex-1 flex-col border-border bg-background",
            selectedId && "lg:border-r",
          )}
        >
          {children}
        </section>

        {/* Detail pane — desktop. Not rendered when nothing is selected so
            the feed keeps the full width. */}
        {selectedId ? (
          <aside className="hidden w-[400px] shrink-0 bg-background lg:block xl:w-[430px]">
            <PersonDetail
              key={selectedId}
              personId={selectedId}
              row={null}
              groups={groups}
              onClose={() => select(null)}
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
            />
          </div>
        ) : null}
      </div>
    </SelectContext.Provider>
  );
}
