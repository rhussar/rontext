"use client";

import { Children, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

/**
 * Collapses a list of rows to `limit`, with a "View more (N)" toggle under it.
 * Rows arrive as server-rendered children, so the sections on Home stay server
 * components — this only counts and slices the nodes. No button renders when
 * everything already fits.
 */
export function ExpandableList({
  limit,
  children,
}: {
  limit: number;
  children: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const items = Children.toArray(children);
  const hidden = items.length - limit;
  return (
    <div>
      <div>{expanded ? items : items.slice(0, limit)}</div>
      {hidden > 0 ? (
        <ViewMoreButton
          expanded={expanded}
          hidden={hidden}
          onClick={() => setExpanded((e) => !e)}
        />
      ) : null}
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
      className="flex items-center gap-1 px-5 py-2 text-[12.5px] font-medium text-blue-600 transition-colors hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
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
