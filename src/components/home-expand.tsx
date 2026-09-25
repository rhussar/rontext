"use client";

import { Children, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

/**
 * A Home section: its header, then its rows collapsed to `limit`, with the
 * "View more (N)" toggle on the right of the header. Rows arrive as
 * server-rendered children, so the sections on Home stay server components —
 * this only counts and slices the nodes. The icon comes in as a rendered
 * element because a component can't cross into a client component. No toggle
 * renders when everything already fits; `empty` shows when there are no rows.
 */
export function ExpandableList({
  icon,
  label,
  limit,
  empty,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  limit: number;
  empty: React.ReactNode;
  children: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const items = Children.toArray(children);
  const hidden = items.length - limit;
  return (
    <section>
      <SectionHeader
        icon={icon}
        label={label}
        action={
          hidden > 0 ? (
            <ViewMoreButton
              expanded={expanded}
              hidden={hidden}
              onClick={() => setExpanded((e) => !e)}
            />
          ) : null
        }
      />
      {items.length === 0 ? (
        empty
      ) : (
        <div>{expanded ? items : items.slice(0, limit)}</div>
      )}
    </section>
  );
}

/** Uppercase section label with an optional control pinned to the far right. */
export function SectionHeader({
  icon,
  label,
  action,
}: {
  icon: React.ReactNode;
  label: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-5 pb-1.5 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground">
      {icon}
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </h2>
      {action ? <div className="ml-auto">{action}</div> : null}
    </div>
  );
}

export function ViewMoreButton({
  expanded,
  hidden,
  onClick,
}: {
  expanded: boolean;
  hidden: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 text-[12.5px] font-medium text-blue-600 transition-colors hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
    >
      {expanded ? (
        <>
          <ChevronUp className="size-3.5" />
          View less
        </>
      ) : (
        <>
          <ChevronDown className="size-3.5" />
          View more ({hidden.toLocaleString()})
        </>
      )}
    </button>
  );
}
