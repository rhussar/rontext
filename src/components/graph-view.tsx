"use client";

import { useCallback, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Building2, GraduationCap, MapPin, Users, X } from "lucide-react";
import type { GraphData } from "@/lib/actions/graph";
import type { Selection } from "@/components/graph-canvas";
import { HUB_COLOR, HUB_COLOR_FALLBACK, HUB_LEGEND } from "@/lib/graph/colors";
import { PersonAvatar } from "@/components/person-avatar";
import { Skeleton } from "@/components/ui/skeleton";

// Sigma touches window/WebGL at import time, and `ssr: false` is not allowed
// in a Server Component — hence this client wrapper around the dynamic import.
const GraphCanvas = dynamic(
  () => import("@/components/graph-canvas").then((m) => m.GraphCanvas),
  {
    ssr: false,
    loading: () => (
      <div className="absolute inset-0 flex items-center justify-center">
        <Skeleton className="size-full" />
      </div>
    ),
  },
);

const TYPE_ICON = {
  company: Building2,
  school: GraduationCap,
  place: MapPin,
  group: Users,
} as const;

const TYPE_LABEL: Record<string, string> = {
  company: "Company",
  school: "School",
  place: "Place",
  group: "Group",
};

export function GraphView({ data }: { data: GraphData }) {
  const [selected, setSelected] = useState<Selection>(null);

  const onSelect = useCallback((s: Selection) => setSelected(s), []);

  const peopleById = useMemo(
    () => new Map(data.people.map((p) => [p.id, p])),
    [data.people],
  );
  const entityById = useMemo(
    () => new Map(data.entities.map((e) => [e.id, e])),
    [data.entities],
  );

  /** Neighbors of the current selection, for the side panel. */
  const detail = useMemo(() => {
    if (!selected) return null;
    if (selected.kind === "entity") {
      const entity = entityById.get(selected.id);
      if (!entity) return null;
      const members = data.edges
        .filter((e) => e.e === selected.id)
        .map((e) => peopleById.get(e.p))
        .filter((p): p is NonNullable<typeof p> => Boolean(p))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { kind: "entity" as const, entity, members };
    }
    const person = peopleById.get(selected.id);
    if (!person) return null;
    const affiliations = data.edges
      .filter((e) => e.p === selected.id)
      .map((e) => entityById.get(e.e))
      .filter((e): e is NonNullable<typeof e> => Boolean(e))
      .sort((a, b) => b.memberCount - a.memberCount);
    return { kind: "person" as const, person, affiliations };
  }, [selected, data.edges, peopleById, entityById]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <div className="flex shrink-0 items-baseline gap-3 border-b border-stone-200 px-5 pb-2.5 pt-3">
        <h1 className="text-[15px] font-semibold text-stone-800">Network</h1>
        <p className="text-[12px] text-stone-400">
          {data.people.length.toLocaleString()} connected people ·{" "}
          {data.entities.length.toLocaleString()} shared affiliations
          {data.isolatedCount > 0 ? (
            <>
              {" · "}
              <span title="These contacts share no company, school, place or group with anyone else in your network.">
                {data.isolatedCount.toLocaleString()} not shown
              </span>
            </>
          ) : null}
        </p>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Canvas must be `relative` + `min-h-0 flex-1`: the app shell is
            h-dvh/overflow-hidden, and sigma renders 0x0 without a sized parent. */}
        <div className="relative min-h-0 min-w-0 flex-1 bg-stone-50">
          <GraphCanvas data={data} onSelect={onSelect} selected={selected} />
          <Legend />
        </div>

        {detail ? (
          <aside className="hidden w-[400px] shrink-0 overflow-y-auto border-l border-stone-200 bg-white md:block xl:w-[430px]">
            <div className="flex items-start justify-between gap-2 border-b border-stone-200 px-5 py-3">
              <div className="min-w-0">
                {detail.kind === "entity" ? (
                  <>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-stone-400">
                      {TYPE_LABEL[detail.entity.type] ?? detail.entity.type}
                    </p>
                    <h2 className="truncate text-[15px] font-semibold text-stone-800">
                      {detail.entity.name}
                    </h2>
                    <p className="text-[12.5px] text-stone-500">
                      {detail.entity.memberCount} people
                    </p>
                  </>
                ) : (
                  <>
                    <h2 className="truncate text-[15px] font-semibold text-stone-800">
                      {detail.person.name}
                    </h2>
                    <p className="truncate text-[12.5px] text-stone-500">
                      {[detail.person.title, detail.person.company]
                        .filter(Boolean)
                        .join(" · ") || "—"}
                    </p>
                  </>
                )}
              </div>
              <button
                onClick={() => setSelected(null)}
                aria-label="Close"
                className="rounded p-1 text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600"
              >
                <X className="size-4" />
              </button>
            </div>

            {detail.kind === "entity" ? (
              <ul className="divide-y divide-stone-100">
                {detail.members.map((m) => (
                  <li key={m.id}>
                    <Link
                      href={`/people?person=${m.id}`}
                      className="flex items-center gap-2.5 px-5 py-2 transition-colors hover:bg-stone-50"
                    >
                      <PersonAvatar name={m.name} className="size-7 text-[10px]" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13.5px] text-stone-800">
                          {m.name}
                        </span>
                        {m.title ? (
                          <span className="block truncate text-[11.5px] text-stone-400">
                            {m.title}
                          </span>
                        ) : null}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="px-5 py-3">
                <p className="pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-stone-400">
                  Shared affiliations
                </p>
                <ul className="flex flex-col gap-1">
                  {detail.affiliations.map((a) => {
                    const Icon = TYPE_ICON[a.type as keyof typeof TYPE_ICON] ?? Building2;
                    return (
                      <li key={a.id}>
                        <button
                          onClick={() => setSelected({ kind: "entity", id: a.id })}
                          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-stone-50"
                        >
                          <Icon className="size-4 shrink-0 text-stone-400" />
                          <span className="min-w-0 flex-1 truncate text-[13.5px] text-stone-700">
                            {a.name}
                          </span>
                          <span className="shrink-0 text-[11.5px] text-stone-400">
                            {a.memberCount}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <Link
                  href={`/people?person=${detail.person.id}`}
                  className="mt-3 inline-block text-[13px] font-medium text-blue-600 hover:underline"
                >
                  Open full profile →
                </Link>
              </div>
            )}
          </aside>
        ) : null}
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 flex flex-col gap-1 rounded-lg border border-stone-200 bg-white/90 px-2.5 py-2 text-[11px] text-stone-500 shadow-xs backdrop-blur-sm">
      {HUB_LEGEND.map(({ type, label }) => (
        <span key={type} className="flex items-center gap-1.5">
          <span
            className="size-2.5 rounded-full"
            style={{ backgroundColor: HUB_COLOR[type] ?? HUB_COLOR_FALLBACK }}
          />
          {label}
        </span>
      ))}
      <span className="mt-0.5 flex items-center gap-1.5 border-t border-stone-100 pt-1">
        <span className="size-2 rounded-full bg-sky-500" />
        Person — color by cluster
      </span>
    </div>
  );
}
