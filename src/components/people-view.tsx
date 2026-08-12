"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, GitMerge, Search, SlidersHorizontal, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PersonRow } from "@/lib/actions/contacts";
import { useShell, type GroupWithCount } from "@/components/app-shell";
import { displayName } from "@/lib/format";
import { MergeDialog } from "@/components/merge-dialog";
import { PersonAvatar } from "@/components/person-avatar";
import { PersonDetail } from "@/components/person-detail";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

type SortKey = "first" | "last" | "recent";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "first", label: "First name" },
  { key: "last", label: "Last name" },
  { key: "recent", label: "Recently added" },
];

type ToggleKey = "starred" | "notes" | "linkedin" | "birthday";

const TOGGLES: { key: ToggleKey; label: string }[] = [
  { key: "starred", label: "Starred" },
  { key: "notes", label: "Has notes" },
  { key: "linkedin", label: "Has LinkedIn" },
  { key: "birthday", label: "Has birthday" },
];

const NO_TOGGLES: Record<ToggleKey, boolean> = {
  starred: false,
  notes: false,
  linkedin: false,
  birthday: false,
};

function lastNameKey(p: PersonRow): string {
  if (p.lastName) return p.lastName.toLowerCase();
  const parts = p.fullName.trim().split(/\s+/);
  return (parts[parts.length - 1] ?? "").toLowerCase();
}

function FilterLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-1.5 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </p>
  );
}

export function PeopleView({
  people,
  groups,
  groupParam,
  initialPersonId,
  archived,
}: {
  people: PersonRow[];
  groups: GroupWithCount[];
  groupParam?: string;
  initialPersonId?: number;
  archived: boolean;
}) {
  const shell = useShell();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("first");
  const [toggles, setToggles] = useState<Record<ToggleKey, boolean>>(NO_TOGGLES);
  const [selectedId, setSelectedId] = useState<number | null>(
    initialPersonId ?? null,
  );
  // The second half of a ⌘-click merge pair; the first half is `selectedId`.
  const [mergeId, setMergeId] = useState<number | null>(null);
  const [cmdHeld, setCmdHeld] = useState(false);

  // A router push from elsewhere (search palette, Home) re-renders this client
  // component with a new initialPersonId rather than remounting it, so adjust
  // during render — the internal `select` path uses history.replaceState and
  // leaves this prop untouched, so it can't fight with it.
  const [lastInitialId, setLastInitialId] = useState(initialPersonId);
  if (initialPersonId !== lastInitialId) {
    setLastInitialId(initialPersonId);
    if (initialPersonId !== undefined) setSelectedId(initialPersonId);
  }

  // Keep selection in sync with browser back/forward (mobile back gesture)
  useEffect(() => {
    function onPop() {
      const sp = new URLSearchParams(window.location.search);
      const p = sp.get("person");
      setSelectedId(p && /^\d+$/.test(p) ? Number(p) : null);
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Light up the merge affordance only while ⌘ is actually down. Reading
  // e.metaKey off both keydown and keyup covers the release too, and `blur`
  // is the ⌘-Tab escape hatch — that leaves no keyup for us to hear.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      setCmdHeld(e.metaKey);
    }
    function clear() {
      setCmdHeld(false);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", clear);
    };
  }, []);

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

  // ⌘-click a second person while one is open: offer to merge instead of
  // moving the selection. Without a selection there's no pair, so ⌘ falls
  // through to an ordinary click.
  const clickRow = useCallback(
    (id: number, e: React.MouseEvent) => {
      if (e.metaKey && selectedId !== null && id !== selectedId) {
        e.preventDefault();
        setMergeId(id);
        return;
      }
      select(id);
    },
    [selectedId, select],
  );

  const activeGroup =
    groupParam && groupParam !== "starred"
      ? groups.find((g) => String(g.id) === groupParam)
      : undefined;

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let rows = people.filter((p) => p.archived === archived);
    if (groupParam === "starred") rows = rows.filter((p) => p.starred);
    else if (activeGroup)
      rows = rows.filter((p) => p.groupIds.includes(activeGroup.id));
    if (needle) {
      rows = rows.filter((p) =>
        `${p.fullName} ${p.company ?? ""} ${p.title ?? ""}`
          .toLowerCase()
          .includes(needle),
      );
    }
    if (toggles.starred) rows = rows.filter((p) => p.starred);
    if (toggles.notes) rows = rows.filter((p) => p.hasNotes);
    if (toggles.linkedin) rows = rows.filter((p) => p.hasLinkedin);
    if (toggles.birthday) rows = rows.filter((p) => !!p.birthday);
    const sorted = [...rows];
    if (sort === "first")
      sorted.sort((a, b) => a.fullName.localeCompare(b.fullName));
    else if (sort === "last")
      sorted.sort((a, b) => lastNameKey(a).localeCompare(lastNameKey(b)));
    else
      sorted.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return sorted;
  }, [people, q, sort, toggles, groupParam, activeGroup, archived]);

  // Sort isn't counted — it's always set, so it would read as a permanent filter.
  const activeCount =
    (q.trim() ? 1 : 0) + Object.values(toggles).filter(Boolean).length;

  function reset() {
    setQ("");
    setToggles(NO_TOGGLES);
  }

  const selectedRow = people.find((p) => p.id === selectedId) ?? null;
  const mergeRow = people.find((p) => p.id === mergeId) ?? null;
  // Every visible row other than the open one is a candidate while ⌘ is down.
  const mergeArmed = cmdHeld && selectedRow !== null;

  return (
    <div className="flex h-full min-h-0 bg-muted md:p-0">
      {/* List pane */}
      <section className="flex min-w-0 flex-1 flex-col border-border bg-background md:m-0 md:border-r">
        {/* Tabs row */}
        <div className="flex items-center gap-5 border-b border-border px-5 pt-3">
          {activeGroup || groupParam === "starred" ? (
            <div className="flex items-center gap-2 pb-2.5 text-[15px] font-semibold text-foreground">
              {groupParam === "starred" ? (
                <Star className="size-3.5 fill-amber-400 text-amber-400" />
              ) : (
                <span
                  className="size-2 rounded-full"
                  style={{ backgroundColor: activeGroup!.color }}
                />
              )}
              {groupParam === "starred" ? "Starred" : activeGroup!.name}
            </div>
          ) : (
            <>
              <Tab href="/people" label="People" active={!archived} />
              <Tab
                href="/people?tab=discovered"
                label="Data"
                active={false}
              />
              <Tab href="/people?tab=archive" label="Archive" active={archived} />
            </>
          )}

          <div className="ml-auto flex items-center pb-2 pl-3">
            <Popover>
              <PopoverTrigger
                render={
                  <button
                    aria-label="Filter and sort"
                    title="Filter and sort"
                    className={cn(
                      "relative flex size-7 items-center justify-center rounded-md transition-colors",
                      activeCount > 0
                        ? "bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-950/50"
                        : "text-muted-foreground hover:bg-muted",
                    )}
                  >
                    <SlidersHorizontal className="size-4" />
                    {/* Corner badge, since there's no label left to sit beside */}
                    {activeCount > 0 ? (
                      <span className="absolute -right-1 -top-1 flex size-3.5 items-center justify-center rounded-full bg-blue-600 text-[9px] font-bold leading-none text-white">
                        {activeCount}
                      </span>
                    ) : null}
                  </button>
                }
              />
              <PopoverContent align="end" className="w-64 p-3">
                {/* The spacing sits on the outer div — on the relative one it
                    would pad the box the icon centres against, pushing it low. */}
                <div className="pb-3">
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <input
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                      placeholder="Search name, company, title"
                      autoFocus
                      className="h-8 w-full rounded-md border border-input bg-transparent pl-8 pr-2 text-[13px] outline-none placeholder:text-muted-foreground focus:border-ring"
                    />
                  </div>
                </div>

                <FilterLabel>Sort by</FilterLabel>
                <div className="flex flex-col pb-1">
                  {SORTS.map((s) => (
                    <button
                      key={s.key}
                      onClick={() => setSort(s.key)}
                      className="flex items-center gap-2 rounded px-1.5 py-1.5 text-left text-[13px] text-foreground hover:bg-muted"
                    >
                      <Check
                        className={cn(
                          "size-3.5",
                          sort === s.key ? "text-blue-600 dark:text-blue-400" : "opacity-0",
                        )}
                      />
                      {s.label}
                    </button>
                  ))}
                </div>

                <FilterLabel>Show only</FilterLabel>
                <div className="flex flex-col">
                  {TOGGLES.map((t) => (
                    <button
                      key={t.key}
                      onClick={() =>
                        setToggles((prev) => ({ ...prev, [t.key]: !prev[t.key] }))
                      }
                      className="flex items-center gap-2 rounded px-1.5 py-1.5 text-left text-[13px] text-foreground hover:bg-muted"
                    >
                      <Check
                        className={cn(
                          "size-3.5",
                          toggles[t.key] ? "text-blue-600 dark:text-blue-400" : "opacity-0",
                        )}
                      />
                      {t.label}
                    </button>
                  ))}
                </div>

                {activeCount > 0 ? (
                  <button
                    onClick={reset}
                    className="mt-2 w-full rounded-md border border-border py-1.5 text-[12.5px] text-muted-foreground hover:bg-muted"
                  >
                    Clear filters
                  </button>
                ) : null}
              </PopoverContent>
            </Popover>
          </div>
        </div>

        {/* Count */}
        <div className="px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {filtered.length.toLocaleString()}{" "}
          {filtered.length === 1 ? "person" : "people"}
        </div>

        {/* Rows */}
        <div className="min-h-0 flex-1 overflow-y-auto pb-8">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-6 pt-16 text-center">
              <p className="text-[15px] font-medium text-foreground/80">
                {people.length === 0 ? "No people yet" : "No people match"}
              </p>
              {people.length === 0 ? (
                <p className="text-[13.5px] text-muted-foreground">
                  <button
                    onClick={shell.openSettings}
                    className="text-blue-600 dark:text-blue-400 underline"
                  >
                    Import your contacts
                  </button>{" "}
                  from Settings → Accounts to fill this list.
                </p>
              ) : null}
            </div>
          ) : (
            filtered.map((p) => (
              <PersonListRow
                key={p.id}
                person={p}
                selected={p.id === selectedId}
                mergeTarget={mergeArmed && p.id !== selectedId}
                onSelect={(e) => clickRow(p.id, e)}
              />
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
            row={selectedRow}
            groups={groups}
            onClose={() => select(null)}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-8 text-center text-[13.5px] text-muted-foreground">
            Select a person to see their details
          </div>
        )}
      </aside>

      {selectedRow && mergeRow ? (
        <MergeDialog
          a={selectedRow}
          b={mergeRow}
          open
          onOpenChange={(o) => {
            if (!o) setMergeId(null);
          }}
          onMerged={(keeperId) => {
            setMergeId(null);
            select(keeperId);
            // The list is a server prop, so the loser only disappears once
            // the route re-renders.
            router.refresh();
          }}
        />
      ) : null}

      {/* Detail — mobile overlay */}
      {selectedId ? (
        <div className="fixed inset-0 z-40 bg-background pt-[env(safe-area-inset-top)] lg:hidden">
          <PersonDetail
            key={`m-${selectedId}`}
            personId={selectedId}
            row={selectedRow}
            groups={groups}
            onClose={() => select(null)}
          />
        </div>
      ) : null}
    </div>
  );
}

function Tab({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "border-b-2 pb-2.5 text-[15px] font-semibold transition-colors",
        active
          ? "border-foreground text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground/80",
      )}
    >
      {label}
    </Link>
  );
}

function PersonListRow({
  person,
  selected,
  mergeTarget,
  onSelect,
}: {
  person: PersonRow;
  selected: boolean;
  mergeTarget: boolean;
  onSelect: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={cn(
        "group relative flex w-full items-center gap-2 px-5 py-3 text-left transition-colors [content-visibility:auto] [contain-intrinsic-size:auto_48px]",
        selected
          ? "bg-blue-50/80 dark:bg-blue-950/40"
          : mergeTarget
            ? "cursor-copy hover:bg-blue-50/60 dark:hover:bg-blue-950/40"
            : "hover:bg-muted/50",
      )}
    >
      {selected ? (
        <span className="absolute inset-y-0 left-0 w-[3px] bg-blue-600" />
      ) : null}
      <span className="truncate text-[15px] font-medium text-foreground">
        {displayName(person.fullName)}
      </span>
      {person.starred ? (
        <Star className="size-3.5 shrink-0 fill-amber-400 text-amber-400" />
      ) : null}
      {person.hasLinkedin ? (
        <span className="flex size-[15px] shrink-0 items-center justify-center rounded-[3px] bg-[#0a66c2] text-[8.5px] font-bold leading-none text-white">
          in
        </span>
      ) : null}
      {person.hasNotes ? (
        <svg
          viewBox="0 0 16 16"
          className="size-[15px] shrink-0 fill-orange-400"
          aria-label="Has notes"
        >
          <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v6a1.5 1.5 0 0 1-1.5 1.5H8l-3.4 2.72A.6.6 0 0 1 3.6 13.2V11h-.1A1.5 1.5 0 0 1 2 9.5v-6Z" />
        </svg>
      ) : null}
      {/* Only on hover: with ⌘ down every row would otherwise shout at once. */}
      {mergeTarget ? (
        <span className="ml-auto flex shrink-0 items-center gap-1 rounded-full bg-blue-600 px-2 py-0.5 text-[10.5px] font-semibold text-white opacity-0 transition-opacity group-hover:opacity-100">
          <GitMerge className="size-3" />
          Merge
        </span>
      ) : null}
      <PersonAvatar
        name={person.fullName}
        photoSrc={person.hasPhoto ? `/api/photos/${person.id}` : null}
        className="ml-auto size-8"
      />
    </button>
  );
}
