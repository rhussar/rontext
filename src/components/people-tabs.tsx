import Link from "next/link";
import { cn } from "@/lib/utils";

export type PeopleTab =
  | "people"
  | "discovered"
  | "duplicates"
  | "cleanup"
  | "archive"
  | "network";

/** The three review queues, collapsed under one "Data" tab so the header
 * doesn't carry six items — this array also drives the sub-nav order. */
const DATA_TABS: { key: PeopleTab; label: string; href: string }[] = [
  { key: "discovered", label: "Discovered", href: "/people?tab=discovered" },
  { key: "duplicates", label: "Duplicates", href: "/people?tab=duplicates" },
  { key: "cleanup", label: "Cleanup", href: "/people?tab=cleanup" },
];

/**
 * Membership, not exclusion. The old form ("anything that isn't people or
 * archive") silently swept every new top-level tab into the Data group — which
 * is exactly what Network would have hit.
 */
const isDataTab = (t: PeopleTab) => DATA_TABS.some((d) => d.key === t);

/** The top-level row, in order. One source of truth for every pane. */
const TOP_TABS = [
  { key: "people", label: "People", href: "/people" },
  { key: "data", label: "Data", href: DATA_TABS[0].href },
  { key: "archive", label: "Archive", href: "/people?tab=archive" },
  { key: "network", label: "Network", href: "/people?tab=network" },
] as const;

const topTabActive = (key: string, active: PeopleTab) =>
  key === "data" ? isDataTab(active) : key === active;

/**
 * Fixed height, and it has to stay fixed.
 *
 * The row's natural height is set by its tallest child, so a pane that puts a
 * button in the actions slot (People's filter, at 28px + padding) came out
 * taller than one that puts nothing there — 49px vs 46.5px — and the whole tab
 * strip visibly jumped as you moved between them. min-h pins it at the taller
 * of the two, so actions can come and go without moving the tabs.
 */
const ROW = "flex min-h-12 items-center gap-5 overflow-x-auto px-5 pt-3";

/**
 * The shared top row. Every pane under People renders this exact element —
 * the People list pane used to keep its own near-copy, which is how it drifted
 * into a different height and a `shrink-0` its twin had.
 *
 * `lead` replaces the tabs entirely (the People pane shows a group's name in
 * their place); `children` fills the right-hand actions slot; `reserveBell`
 * keeps a full-width pane clear of the shell's floating notifications button,
 * which a pane inside the split layout doesn't need.
 */
export function TopTabRow({
  active,
  lead,
  children,
  reserveBell = false,
}: {
  active: PeopleTab;
  lead?: React.ReactNode;
  children?: React.ReactNode;
  reserveBell?: boolean;
}) {
  return (
    // pr-14: the bell is 36px wide and sits 12px from the edge, so pr-12
    // lands the last action flush against it with zero gap.
    <div className={cn(ROW, reserveBell && "md:pr-14")}>
      {lead ??
        TOP_TABS.map((t) => (
          <TopTab
            key={t.key}
            href={t.href}
            label={t.label}
            active={topTabActive(t.key, active)}
          />
        ))}
      {children ? (
        <div className="ml-auto flex shrink-0 items-center gap-2 pb-2 pl-3">
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function PeopleTabs({
  active,
  children,
}: {
  active: PeopleTab;
  children?: React.ReactNode;
}) {
  const onData = isDataTab(active);

  return (
    <div className="border-b border-border">
      <TopTabRow active={active} reserveBell>
        {children}
      </TopTabRow>

      {/* Sub-nav: only the "Data" tab has multiple queues underneath it. */}
      {onData ? (
        <div className="flex items-center gap-1.5 px-5 pb-2.5 pt-2">
          {DATA_TABS.map((t) => (
            <Link
              key={t.key}
              href={t.href}
              className={cn(
                "shrink-0 rounded-full px-2.5 py-1 text-[12.5px] font-medium transition-colors",
                active === t.key
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              {t.label}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TopTab({
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
        "shrink-0 border-b-2 pb-2.5 text-[15px] font-semibold transition-colors",
        active
          ? "border-foreground text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground/80",
      )}
    >
      {label}
    </Link>
  );
}
