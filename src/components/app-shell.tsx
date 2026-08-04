"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import type { Group } from "@/db/schema";
import { Sidebar } from "@/components/sidebar";
import { NewPersonDialog } from "@/components/new-person-dialog";
import { NewNoteDialog } from "@/components/new-note-dialog";
import { NewGroupDialog } from "@/components/new-group-dialog";
import { SearchPalette } from "@/components/search-palette";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

export type GroupWithCount = Group & { memberCount: number };

type ShellContextValue = {
  openNewPerson: () => void;
  openNewNote: () => void;
  openNewGroup: () => void;
  openSearch: () => void;
};

const ShellContext = createContext<ShellContextValue | null>(null);
export const useShell = () => {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell outside AppShell");
  return ctx;
};

const PAGE_TITLES: Record<string, string> = {
  "/": "Home",
  "/people": "People",
  "/notes": "Notes",
  "/import": "Import",
};

export function AppShell({
  groups,
  children,
}: {
  groups: GroupWithCount[];
  children: React.ReactNode;
}) {
  const [newPersonOpen, setNewPersonOpen] = useState(false);
  const [newNoteOpen, setNewNoteOpen] = useState(false);
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen((o) => !o);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const ctx: ShellContextValue = {
    openNewPerson: () => setNewPersonOpen(true),
    openNewNote: () => setNewNoteOpen(true),
    openNewGroup: () => setNewGroupOpen(true),
    openSearch: () => setSearchOpen(true),
  };

  return (
    <ShellContext.Provider value={ctx}>
      <div className="flex h-dvh overflow-hidden bg-stone-100">
        {/* Desktop sidebar */}
        <aside className="hidden w-60 shrink-0 md:block">
          <Sidebar groups={groups} />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Mobile top bar */}
          <header className="flex h-12 shrink-0 items-center gap-1 border-b border-stone-200 bg-stone-50 px-2 pt-[env(safe-area-inset-top)] md:hidden">
            <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
              <SheetTrigger
                render={
                  <Button variant="ghost" size="icon" aria-label="Menu">
                    <Menu className="size-5" />
                  </Button>
                }
              />
              <SheetContent side="left" className="w-72 p-0">
                <SheetTitle className="sr-only">Navigation</SheetTitle>
                <Sidebar groups={groups} />
              </SheetContent>
            </Sheet>
            <span className="text-sm font-semibold text-stone-700">
              {PAGE_TITLES[pathname] ?? "Mesh"}
            </span>
          </header>

          <main className="min-h-0 flex-1">{children}</main>
        </div>
      </div>

      <NewPersonDialog
        open={newPersonOpen}
        onOpenChange={setNewPersonOpen}
        groups={groups}
      />
      <NewNoteDialog open={newNoteOpen} onOpenChange={setNewNoteOpen} />
      <NewGroupDialog open={newGroupOpen} onOpenChange={setNewGroupOpen} />
      <SearchPalette open={searchOpen} onOpenChange={setSearchOpen} />
    </ShellContext.Provider>
  );
}
