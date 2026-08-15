"use client";

import { useCallback, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import type { GraphData } from "@/lib/graph/query";
import type { Selection } from "@/lib/graph/interactions";
import { cn } from "@/lib/utils";
import { CompanyPanel } from "@/components/graph/company-panel";
import { NetworkSettings } from "@/components/graph/network-settings";
import { PeopleTabs } from "@/components/people-tabs";
import { PersonDetail } from "@/components/person-detail";
import type { GroupWithCount } from "@/components/app-shell";
import { Skeleton } from "@/components/ui/skeleton";

// Sigma touches window/WebGL at import time, and `ssr: false` is not allowed
// in a Server Component — hence this client wrapper around the dynamic import.
const GraphCanvas = dynamic(
  () => import("@/components/graph/graph-canvas").then((m) => m.GraphCanvas),
  {
    ssr: false,
    loading: () => (
      <div className="absolute inset-0 flex items-center justify-center">
        <Skeleton className="size-full" />
      </div>
    ),
  },
);

export function GraphView({
  data,
  groups,
}: {
  data: GraphData;
  groups: GroupWithCount[];
}) {
  const [selected, setSelected] = useState<Selection>(null);
  /**
   * The company whose member list a person profile was opened from — the back
   * arrow returns there. Canvas clicks have no list context, so they clear it
   * and the arrow just closes the panel.
   */
  const [backCompanyId, setBackCompanyId] = useState<number | null>(null);

  const onSelect = useCallback((s: Selection) => {
    setBackCompanyId(null);
    setSelected(s);
  }, []);

  const peopleById = useMemo(
    () => new Map(data.people.map((p) => [p.id, p])),
    [data.people],
  );
  const companyById = useMemo(
    () => new Map(data.companies.map((c) => [c.id, c])),
    [data.companies],
  );

  /** What the side panel shows. People get the full profile, so only the id
   *  is needed — PersonDetail fetches its own record. */
  const detail = useMemo(() => {
    if (!selected) return null;
    if (selected.kind === "company") {
      const company = companyById.get(selected.id);
      if (!company) return null;
      const members = data.edges
        .filter((e) => e.e === selected.id)
        .map((e) => peopleById.get(e.p))
        .filter((p): p is NonNullable<typeof p> => Boolean(p))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { kind: "company" as const, company, members };
    }
    return { kind: "person" as const, personId: selected.id };
  }, [selected, data.edges, peopleById, companyById]);

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background">
      {/* Network is a People tab, so it wears the same header as its siblings. */}
      <div className="shrink-0">
        <PeopleTabs active="network" />
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Canvas must be `relative` + `min-h-0 flex-1`: the app shell is
            h-dvh/overflow-hidden, and sigma renders 0x0 without a sized parent. */}
        <div className="relative min-h-0 min-w-0 flex-1 bg-muted/50">
          <GraphCanvas data={data} onSelect={onSelect} selected={selected} />
          {/* Floats over the canvas rather than sitting in the tab row, so the
              control reads as belonging to the graph. Anchored to the canvas
              pane, so it follows the edge inward when the detail panel opens. */}
          <div className="absolute right-3 top-3 z-10">
            <NetworkSettings
              people={data.people.length}
              companies={data.companies.length}
              unconnected={data.unconnectedCount}
            />
          </div>
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
                    backCompanyId != null
                      ? { kind: "company", id: backCompanyId }
                      : null,
                  )
                }
              />
            ) : (
              <CompanyPanel
                company={detail.company}
                members={detail.members}
                onClose={() => setSelected(null)}
                onSelectPerson={(personId) => {
                  setBackCompanyId(detail.company.id);
                  setSelected({ kind: "person", id: personId });
                }}
              />
            )}
          </aside>
        ) : null}
      </div>
    </div>
  );
}
