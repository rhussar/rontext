"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CircleUser, Home, Megaphone, PenLine, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { useShell } from "@/components/app-shell";

/**
 * Four of the sidebar's five nav entries. Applications is deliberately absent —
 * the centre slot is worth more as a create action than as a fifth destination,
 * and Applications is still one tap away in the drawer, next to Groups.
 */
const TABS = [
  { href: "/", icon: Home, label: "Home" },
  { href: "/people", icon: CircleUser, label: "People" },
  { href: "/drafts", icon: PenLine, label: "Drafts" },
  { href: "/social", icon: Megaphone, label: "Social" },
];

/**
 * Fixed-height icon slot. Every item gets one so the labels share a baseline
 * even though the add button's disc is taller than a 22px glyph — it overflows
 * the slot by 2px either side rather than pushing its own label down.
 */
function IconSlot({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex h-[22px] items-center justify-center">{children}</span>
  );
}

/**
 * Phone-only tab bar. Sits in normal flow rather than fixed, so `main` shrinks
 * around it and no scroll container needs bottom padding to clear it. The bar
 * itself absorbs the home-indicator inset, which is why the padding is on the
 * nav and not on its items.
 */
export function BottomTabs() {
  const pathname = usePathname();
  const shell = useShell();

  const tab = ({ href, icon: Icon, label }: (typeof TABS)[number]) => {
    // Compared on pathname alone so /people?group=3 still lights up People.
    const active = pathname === href;
    return (
      <Link
        key={href}
        href={href}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex min-w-0 flex-1 flex-col items-center gap-0.5 py-1.5 transition-colors",
          active ? "text-foreground" : "text-muted-foreground",
        )}
      >
        <IconSlot>
          <Icon className="size-[22px]" strokeWidth={active ? 2.4 : 2} />
        </IconSlot>
        <span
          className={cn(
            "w-full truncate px-0.5 text-center text-[10px]",
            active ? "font-semibold" : "font-medium",
          )}
        >
          {label}
        </span>
      </Link>
    );
  };

  return (
    <nav
      aria-label="Primary"
      className="flex shrink-0 border-t border-border bg-muted pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {shell.demo ? (
        // Read-only: no centre "Add" slot, just the four destinations.
        TABS.map(tab)
      ) : (
        <>
      {TABS.slice(0, 2).map(tab)}

      <button
        type="button"
        onClick={shell.openNewPerson}
        aria-label="Add person"
        className="flex min-w-0 flex-1 flex-col items-center gap-0.5 py-1.5 text-muted-foreground"
      >
        <IconSlot>
          <span className="flex size-[26px] items-center justify-center rounded-full bg-primary transition-transform active:scale-90">
            <Plus className="size-4 text-primary-foreground" strokeWidth={2.6} />
          </span>
        </IconSlot>
        <span className="w-full truncate px-0.5 text-center text-[10px] font-medium">
          Add
        </span>
      </button>

      {TABS.slice(2).map(tab)}
        </>
      )}
    </nav>
  );
}
