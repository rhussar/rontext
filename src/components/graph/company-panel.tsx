"use client";

import { X } from "lucide-react";
import type { GraphCompany, GraphPerson } from "@/lib/graph/query";
import { PersonAvatar } from "@/components/person-avatar";
import { CompanyLogoButton } from "@/components/graph/logo-controls";

/**
 * The right-hand detail for a clicked company hub: logo-editable title,
 * member count, and the member list. Clicking a member is selection, not
 * navigation — the panel swaps to that person's full profile and their node
 * lights up on the canvas.
 */
export function CompanyPanel({
  company,
  members,
  onClose,
  onSelectPerson,
}: {
  company: GraphCompany;
  members: GraphPerson[];
  onClose: () => void;
  onSelectPerson: (personId: number) => void;
}) {
  return (
    <>
      <div className="flex items-start justify-between gap-2 border-b border-border px-5 py-3">
        {/* flex-1 so the title row can use the panel width instead of
            collapsing to its own content and truncating early */}
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Company
          </p>
          {/* The title itself is the logo control — click to add, replace or
              remove this hub's image. */}
          <CompanyLogoButton company={company} />
          <p className="pt-0.5 text-[12.5px] text-muted-foreground">
            {members.length} {members.length === 1 ? "person" : "people"}
          </p>
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-muted-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      <ul className="divide-y divide-border">
        {members.map((m) => (
          <li key={m.id}>
            <button
              onClick={() => onSelectPerson(m.id)}
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
  );
}
