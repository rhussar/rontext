import Link from "next/link";
import { cn } from "@/lib/utils";

export type PeopleTab =
  | "people"
  | "discovered"
  | "duplicates"
  | "cleanup"
  | "archive";

/** The three review queues, collapsed under one "Data" tab so the header
 * doesn't carry five items — this array also drives the sub-nav order. */
const DATA_TABS: { key: PeopleTab; label: string; href: string }[] = [
  { key: "discovered", label: "Discovered", href: "/people?tab=discovered" },
  { key: "duplicates", label: "Duplicates", href: "/people?tab=duplicates" },
  { key: "cleanup", label: "Cleanup", href: "/people?tab=cleanup" },
];

const isDataTab = (t: PeopleTab) => t !== "people" && t !== "archive";

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
      {/* md:pr-12 keeps right-hand actions clear of the floating notifications button */}
      <div className="flex items-center gap-5 overflow-x-auto px-5 pt-3 md:pr-12">
        <TopTab href="/people" label="People" active={active === "people"} />
        <TopTab
          href={DATA_TABS[0].href}
          label="Data"
          active={onData}
        />
        <TopTab
          href="/people?tab=archive"
          label="Archive"
          active={active === "archive"}
        />
        {children ? (
          <div className="ml-auto flex items-center gap-2 pb-2">{children}</div>
        ) : null}
      </div>

      {/* Sub-nav: only the "Data" tab has multiple queues underneath it. */}
      {onData ? (
        <div className="flex items-center gap-1.5 px-5 pb-2.5 pt-1.5">
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
