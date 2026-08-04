import Link from "next/link";
import { cn } from "@/lib/utils";

export type PeopleTab = "people" | "duplicates" | "cleanup" | "archive";

const TABS: { key: PeopleTab; label: string; href: string }[] = [
  { key: "people", label: "People", href: "/people" },
  { key: "duplicates", label: "Duplicates", href: "/people?tab=duplicates" },
  { key: "cleanup", label: "Cleanup", href: "/people?tab=cleanup" },
  { key: "archive", label: "Archive", href: "/people?tab=archive" },
];

export function PeopleTabs({
  active,
  children,
}: {
  active: PeopleTab;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-5 overflow-x-auto border-b border-stone-200 px-5 pt-3">
      {TABS.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className={cn(
            "shrink-0 border-b-2 pb-2.5 text-[15px] font-semibold transition-colors",
            active === t.key
              ? "border-stone-800 text-stone-800"
              : "border-transparent text-stone-400 hover:text-stone-600",
          )}
        >
          {t.label}
        </Link>
      ))}
      {children ? (
        <div className="ml-auto flex items-center gap-2 pb-2">{children}</div>
      ) : null}
    </div>
  );
}
