"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Search, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PersonRow } from "@/lib/actions/contacts";
import type { GroupWithCount } from "@/components/app-shell";
import { PersonAvatar } from "@/components/person-avatar";
import { PersonDetail } from "@/components/person-detail";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type SortKey = "first" | "last" | "recent";

function lastNameKey(p: PersonRow): string {
  if (p.lastName) return p.lastName.toLowerCase();
  const parts = p.fullName.trim().split(/\s+/);
  return (parts[parts.length - 1] ?? "").toLowerCase();
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
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("first");
  const [selectedId, setSelectedId] = useState<number | null>(
    initialPersonId ?? null,
  );

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
    const sorted = [...rows];
    if (sort === "first")
      sorted.sort((a, b) => a.fullName.localeCompare(b.fullName));
    else if (sort === "last")
      sorted.sort((a, b) => lastNameKey(a).localeCompare(lastNameKey(b)));
    else
      sorted.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return sorted;
  }, [people, q, sort, groupParam, activeGroup, archived]);

  const selectedRow = people.find((p) => p.id === selectedId) ?? null;

  return (
    <div className="flex h-full min-h-0 bg-stone-100 md:p-0">
      {/* List pane */}
      <section className="flex min-w-0 flex-1 flex-col border-stone-200 bg-white md:m-0 md:border-r">
        {/* Tabs row */}
        <div className="flex items-center gap-5 border-b border-stone-200 px-5 pt-3">
          {activeGroup || groupParam === "starred" ? (
            <div className="flex items-center gap-2 pb-2.5 text-[15px] font-semibold text-stone-800">
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
                href="/people?tab=duplicates"
                label="Duplicates"
                active={false}
              />
              <Tab href="/people?tab=cleanup" label="Cleanup" active={false} />
              <Tab href="/people?tab=archive" label="Archive" active={archived} />
            </>
          )}

          <div className="ml-auto flex items-center gap-2 pb-2">
            <div className="relative hidden sm:block">
              <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-stone-400" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Filter"
                className="h-7 w-40 rounded-md border border-transparent bg-stone-100 pl-7 pr-2 text-[13px] outline-none transition-colors placeholder:text-stone-400 focus:border-stone-300 focus:bg-white"
              />
            </div>
            <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
              <SelectTrigger
                size="sm"
                className="h-7 gap-1 border-none bg-transparent px-2 text-[13px] font-medium text-stone-500 shadow-none hover:bg-stone-100"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value="first">First Name</SelectItem>
                <SelectItem value="last">Last Name</SelectItem>
                <SelectItem value="recent">Recently Added</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Mobile filter */}
        <div className="border-b border-stone-100 px-4 py-2 sm:hidden">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-stone-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter people"
              className="h-9 w-full rounded-lg border border-transparent bg-stone-100 pl-8 pr-3 text-[15px] outline-none placeholder:text-stone-400 focus:border-stone-300 focus:bg-white"
            />
          </div>
        </div>

        {/* Count */}
        <div className="px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-stone-400">
          {filtered.length.toLocaleString()}{" "}
          {filtered.length === 1 ? "person" : "people"}
        </div>

        {/* Rows */}
        <div className="min-h-0 flex-1 overflow-y-auto pb-8">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-6 pt-16 text-center">
              <p className="text-[15px] font-medium text-stone-600">
                {people.length === 0 ? "No people yet" : "No people match"}
              </p>
              {people.length === 0 ? (
                <p className="text-[13.5px] text-stone-400">
                  <Link href="/import" className="text-blue-600 underline">
                    Import your combined_contacts.csv
                  </Link>{" "}
                  to fill this list.
                </p>
              ) : null}
            </div>
          ) : (
            filtered.map((p) => (
              <PersonListRow
                key={p.id}
                person={p}
                selected={p.id === selectedId}
                onSelect={() => select(p.id)}
              />
            ))
          )}
        </div>
      </section>

      {/* Detail pane — desktop */}
      <aside className="hidden w-[400px] shrink-0 bg-white lg:block xl:w-[430px]">
        {selectedId ? (
          <PersonDetail
            key={selectedId}
            personId={selectedId}
            row={selectedRow}
            groups={groups}
            onClose={() => select(null)}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-8 text-center text-[13.5px] text-stone-400">
            Select a person to see their details
          </div>
        )}
      </aside>

      {/* Detail — mobile overlay */}
      {selectedId ? (
        <div className="fixed inset-0 z-40 bg-white pt-[env(safe-area-inset-top)] lg:hidden">
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
          ? "border-stone-800 text-stone-800"
          : "border-transparent text-stone-400 hover:text-stone-600",
      )}
    >
      {label}
    </Link>
  );
}

function PersonListRow({
  person,
  selected,
  onSelect,
}: {
  person: PersonRow;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={cn(
        "relative flex w-full items-center gap-2 px-5 py-3 text-left transition-colors [content-visibility:auto] [contain-intrinsic-size:auto_48px]",
        selected ? "bg-blue-50/80" : "hover:bg-stone-50",
      )}
    >
      {selected ? (
        <span className="absolute inset-y-0 left-0 w-[3px] bg-blue-600" />
      ) : null}
      <span className="truncate text-[15px] font-medium text-stone-800">
        {person.fullName}
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
      <PersonAvatar
        name={person.fullName}
        photoSrc={person.hasPhoto ? `/api/photos/${person.id}` : null}
        className="ml-auto size-8"
      />
    </button>
  );
}
