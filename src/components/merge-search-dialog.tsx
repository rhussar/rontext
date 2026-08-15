"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { listPeople, type PersonRow } from "@/lib/actions/contacts";
import { displayName } from "@/lib/format";
import { scorePersonMatch } from "@/lib/person-search";
import { PersonAvatar } from "@/components/person-avatar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const MAX_RESULTS = 8;

/**
 * Step one of merging from a profile's ⋯ menu: find the other contact.
 * Picking a result just hands it back — the caller opens MergeDialog with
 * both people, which is the step that actually merges anything.
 */
export function MergeSearchDialog({
  excludeId,
  open,
  onOpenChange,
  onPick,
}: {
  /** The profile merge was opened from — never offered as its own match. */
  excludeId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (person: PersonRow) => void;
}) {
  const [people, setPeople] = useState<PersonRow[] | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && people === null) listPeople().then(setPeople);
  }, [open, people]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [open]);

  const results = useMemo(() => {
    const pool = (people ?? []).filter((p) => !p.archived && p.id !== excludeId);
    const q = query.trim().toLowerCase();
    if (!q) {
      return [...pool]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, MAX_RESULTS);
    }
    const hits: { person: PersonRow; rank: number }[] = [];
    for (const person of pool) {
      const rank = scorePersonMatch(person, q);
      if (rank >= 0) hits.push({ person, rank });
    }
    hits.sort(
      (a, b) => a.rank - b.rank || a.person.fullName.localeCompare(b.person.fullName),
    );
    return hits.slice(0, MAX_RESULTS).map((h) => h.person);
  }, [people, query, excludeId]);

  // Reset on the way out, so the next open always starts clean.
  function close() {
    setQuery("");
    setActive(0);
    onOpenChange(false);
  }

  function pick(person: PersonRow) {
    close();
    onPick(person);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => {
        const next =
          e.key === "ArrowDown"
            ? Math.min(i + 1, results.length - 1)
            : Math.max(i - 1, 0);
        listRef.current
          ?.querySelectorAll("[data-row]")
          [next]?.scrollIntoView({ block: "nearest" });
        return next;
      });
    } else if (e.key === "Enter" && results[active]) {
      e.preventDefault();
      pick(results[active]);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogHeader className="sr-only">
        <DialogTitle>Merge with…</DialogTitle>
        <DialogDescription>Search for the other contact to merge with</DialogDescription>
      </DialogHeader>
      <DialogContent
        showCloseButton={false}
        className="top-[15%] max-w-lg translate-y-0 overflow-hidden p-0"
      >
        <div className="flex items-center gap-2 border-b border-border px-3.5">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search people to merge with…"
            className="h-11 w-full bg-transparent text-[14.5px] outline-none placeholder:text-muted-foreground"
          />
        </div>

        <div ref={listRef} className="max-h-80 overflow-y-auto p-1">
          {people === null ? (
            <p className="px-3 py-6 text-center text-[13.5px] text-muted-foreground">
              Loading…
            </p>
          ) : results.length === 0 ? (
            <p className="px-3 py-6 text-center text-[13.5px] text-muted-foreground">
              No people match “{query}”.
            </p>
          ) : (
            results.map((person, i) => (
              <button
                key={person.id}
                data-row
                onClick={() => pick(person)}
                onMouseMove={() => setActive(i)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                  i === active ? "bg-muted" : "hover:bg-muted/50",
                )}
              >
                <PersonAvatar
                  name={person.fullName}
                  photoSrc={person.hasPhoto ? `/api/photos/${person.id}` : null}
                  className="size-7"
                  textClass="text-[11px]"
                />
                <span className="min-w-0 flex-1 truncate text-[13.5px] text-foreground">
                  {displayName(person.fullName)}
                </span>
                {person.company || person.title ? (
                  <span className="min-w-0 max-w-[45%] truncate pl-3 text-[12px] text-muted-foreground">
                    {[person.title, person.company].filter(Boolean).join(" · ")}
                  </span>
                ) : null}
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
