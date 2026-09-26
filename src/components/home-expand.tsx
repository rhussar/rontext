"use client";

import { Children, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

/**
 * A Home section: its header, then its rows collapsed to `limit`, with the
 * "View more (N)" toggle under the last row, bottom left. Rows arrive as
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
      <SectionHeader icon={icon} label={label} />
      {items.length === 0 ? (
        empty
      ) : (
        <div>{expanded ? items : items.slice(0, limit)}</div>
      )}
      {hidden > 0 ? (
        <ViewMoreFooter
          expanded={expanded}
          hidden={hidden}
          onClick={() => setExpanded((e) => !e)}
        />
      ) : null}
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

/** The nearest ancestor that scrolls vertically — Home's feed, not the window. */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if ((y === "auto" || y === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/**
 * "View more (N)" / "View less", bottom left under a section's rows.
 *
 * Sitting under the rows, the button would jump every time the list grows or
 * shrinks. Instead it pins itself: before the toggle it notes where it is on
 * screen, and right after the re-render (before paint) scrolls the feed by
 * however far it moved. So it never leaves the cursor — View more, View less,
 * View more can be clicked in place, and the extra rows simply appear above.
 */
export function ViewMoreFooter({
  expanded,
  hidden,
  onClick,
}: {
  expanded: boolean;
  hidden: number;
  onClick: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const topBefore = useRef<number | null>(null);

  useLayoutEffect(() => {
    const before = topBefore.current;
    topBefore.current = null;
    if (before === null || !ref.current) return;
    const moved = ref.current.getBoundingClientRect().top - before;
    if (moved) scrollParent(ref.current)?.scrollBy({ top: moved });
  }, [expanded]);

  return (
    <div className="px-5 pt-1.5">
      <button
        ref={ref}
        onClick={() => {
          topBefore.current = ref.current?.getBoundingClientRect().top ?? null;
          onClick();
        }}
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
    </div>
  );
}
