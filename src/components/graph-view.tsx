"use client";

import { useCallback, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { X } from "lucide-react";
import type { GraphData } from "@/lib/actions/graph";
import type { Selection } from "@/components/graph-canvas";
import { LogoManager } from "@/components/logo-manager";
import { cn } from "@/lib/utils";
import { SelectedEntityLogo } from "@/components/selected-entity-logo";
import { HUB_COLOR, HUB_COLOR_FALLBACK, HUB_LEGEND } from "@/lib/graph/colors";
import { PersonAvatar } from "@/components/person-avatar";
import { PersonDetail } from "@/components/person-detail";
import type { GroupWithCount } from "@/components/app-shell";
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

const TYPE_LABEL: Record<string, string> = {
  company: "Company",
  school: "School",
  place: "Place",
  group: "Group",
};

export function GraphView({
  data,
  groups,
}: {
  data: GraphData;
  groups: GroupWithCount[];
}) {
  const [selected, setSelected] = useState<Selection>(null);
  const [hiddenTypes, setHiddenTypes] = useState<ReadonlySet<string>>(new Set());
  /**
   * The entity whose member list a person profile was opened from — the back
   * arrow returns there. Canvas clicks have no list context, so they clear it
   * and the arrow just closes the panel.
   */
  const [backEntityId, setBackEntityId] = useState<number | null>(null);

  const onSelect = useCallback((s: Selection) => {
    setBackEntityId(null);
    setSelected(s);
  }, []);

  const toggleType = useCallback((type: string) => {
    setHiddenTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);

  const peopleById = useMemo(
    () => new Map(data.people.map((p) => [p.id, p])),
    [data.people],
  );
  const entityById = useMemo(
    () => new Map(data.entities.map((e) => [e.id, e])),
    [data.entities],
  );

  /** What the side panel shows. People get the full profile, so only the id
   *  is needed — PersonDetail fetches its own record. */
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
    return { kind: "person" as const, personId: selected.id };
  }, [selected, data.edges, peopleById, entityById]);

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background">
      {/* Sits beside the alerts bell (which floats at right-3 in the shell) */}
      <div className="absolute right-14 top-1.5 z-20 hidden md:block">
        <LogoManager />
      </div>

      <div className="flex shrink-0 items-baseline gap-3 border-b border-border px-5 pb-2.5 pt-3">
        <h1 className="text-[15px] font-semibold text-foreground">Network</h1>
        <p className="text-[12px] text-muted-foreground">
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
        <div className="relative min-h-0 min-w-0 flex-1 bg-muted/50">
          <GraphCanvas
            data={data}
            onSelect={onSelect}
            selected={selected}
            hiddenTypes={hiddenTypes}
          />
          <TypeToggles hiddenTypes={hiddenTypes} onToggle={toggleType} />
        </div>

        {detail ? (
          <aside
            className={cn(
              "hidden w-[400px] shrink-0 border-l border-border bg-background md:block xl:w-[430px]",
              // PersonDetail scrolls itself; double scrollbars otherwise
              detail.kind === "person" ? "overflow-hidden" : "overflow-y-auto",
            )}
          >
            {detail.kind === "person" ? (
              /* The same full profile as the People tab. Its back arrow
                 returns to the member list it was opened from, or just
                 closes the panel for a direct canvas click. */
              <PersonDetail
                key={detail.personId}
                personId={detail.personId}
                row={null}
                groups={groups}
                clearFloatingMenu={false}
                onClose={() =>
                  setSelected(
                    backEntityId != null
                      ? { kind: "entity", id: backEntityId }
                      : null,
                  )
                }
              />
            ) : (
              <>
                <div className="flex items-start justify-between gap-2 border-b border-border px-5 py-3">
                  {/* flex-1 so the title row can use the panel width instead of
                      collapsing to its own content and truncating early */}
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {TYPE_LABEL[detail.entity.type] ?? detail.entity.type}
                    </p>
                    {/* The title itself is the logo control — click to add,
                        replace or remove this hub's image. */}
                    <SelectedEntityLogo entity={detail.entity} />
                    <p className="pt-0.5 text-[12.5px] text-muted-foreground">
                      {detail.entity.memberCount} people
                    </p>
                  </div>
                  <button
                    onClick={() => setSelected(null)}
                    aria-label="Close"
                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-muted-foreground"
                  >
                    <X className="size-4" />
                  </button>
                </div>

                <ul className="divide-y divide-border">
                  {detail.members.map((m) => (
                    <li key={m.id}>
                      {/* Selection, not navigation: the panel swaps to this
                          person's full profile, and their node lights up on
                          the canvas. */}
                      <button
                        onClick={() => {
                          setBackEntityId(detail.entity.id);
                          setSelected({ kind: "person", id: m.id });
                        }}
                        className="flex w-full items-center gap-2.5 px-5 py-2 text-left transition-colors hover:bg-muted/50"
                      >
                        <PersonAvatar name={m.name} className="size-7 text-[10px]" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13.5px] text-foreground">
                            {m.name}
                          </span>
                          {m.title ? (
                            <span className="block truncate text-[11.5px] text-muted-foreground">
                              {m.title}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </aside>
        ) : null}
      </div>
    </div>
  );
}

/**
 * View filter for the four hub types. Sits top-right on the canvas; hiding a
 * type also hides people whose every visible affiliation went with it, so
 * nothing floats unexplained. Purely a render-layer filter — positions are
 * untouched, so toggling back restores the exact same picture.
 */
function TypeToggles({
  hiddenTypes,
  onToggle,
}: {
  hiddenTypes: ReadonlySet<string>;
  onToggle: (type: string) => void;
}) {
  return (
    <div className="absolute right-3 top-3 z-10 flex items-center gap-0.5 rounded-lg border border-border bg-background/90 p-1 shadow-xs backdrop-blur-sm">
      {HUB_LEGEND.map(({ type, label }) => {
        const off = hiddenTypes.has(type);
        return (
          <button
            key={type}
            aria-pressed={!off}
            title={off ? `Show ${label.toLowerCase()} nodes` : `Hide ${label.toLowerCase()} nodes`}
            onClick={() => onToggle(type)}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium transition-colors",
              off
                ? "text-muted-foreground hover:bg-muted hover:text-muted-foreground"
                : "text-foreground hover:bg-muted",
            )}
          >
            <span
              className="size-2 rounded-full transition-opacity"
              style={{
                backgroundColor: HUB_COLOR[type] ?? HUB_COLOR_FALLBACK,
                opacity: off ? 0.25 : 1,
              }}
            />
            <span className={off ? "line-through decoration-muted-foreground/40" : undefined}>
              {label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

