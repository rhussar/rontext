"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import type { Group } from "@/db/schema";
import { Sidebar } from "@/components/sidebar";
import { ActivityMenu } from "@/components/activity-menu";
import { NewPersonDialog } from "@/components/new-person-dialog";
import { NewNoteDialog } from "@/components/new-note-dialog";
import { NewGroupDialog } from "@/components/new-group-dialog";
import { SearchPalette } from "@/components/search-palette";
import { SettingsDialog } from "@/components/settings-dialog";
import type { ConnectionStatus } from "@/lib/connections";
import type { SetupStatus } from "@/lib/setup";
import { watchSystemTheme } from "@/lib/theme";
import type { Settings, WorkspaceColor } from "@/lib/settings";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

export type GroupWithCount = Group & { memberCount: number };

type ShellContextValue = {
  openNewPerson: () => void;
  openNewNote: () => void;
  openNewGroup: () => void;
  openSearch: () => void;
  openSettings: () => void;
  workspaceName: string;
  workspaceColor: WorkspaceColor;
  /** "HH:MM" the reminder composer starts at. */
  defaultReminderTime: string;
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
  "/graph": "Network",
  "/drafts": "Drafts",
  "/notes": "Notes",
};

export function AppShell({
  groups,
  settings,
  connections,
  setup,
  children,
}: {
  groups: GroupWithCount[];
  settings: Settings;
  connections: ConnectionStatus[];
  setup: SetupStatus[];
  children: React.ReactNode;
}) {
  const [newPersonOpen, setNewPersonOpen] = useState(false);
  const [newNoteOpen, setNewNoteOpen] = useState(false);
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const pathname = usePathname();

  // Only does anything on "Automatic" — keeps the theme in step with the OS.
  useEffect(() => watchSystemTheme(settings.theme), [settings.theme]);

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
    openSettings: () => setSettingsOpen(true),
    workspaceName: settings.workspaceName,
    workspaceColor: settings.workspaceColor,
    defaultReminderTime: settings.defaultReminderTime,
  };

  return (
    <ShellContext.Provider value={ctx}>
      <div className="relative flex h-dvh overflow-hidden bg-muted">
        {/* Desktop sidebar */}
        <aside className="hidden w-60 shrink-0 md:block">
          <Sidebar groups={groups} />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Mobile top bar */}
          <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border bg-muted/50 px-2 pt-[env(safe-area-inset-top)] md:hidden">
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
            <span className="text-sm font-semibold text-foreground">
              {PAGE_TITLES[pathname] ?? "Rontext"}
            </span>
            <div className="ml-auto pr-1">
              <ActivityMenu />
            </div>
          </header>

          <main className="min-h-0 flex-1">{children}</main>
        </div>

        {/* Floats over the content pane, as in Mesh. top-1.5 keeps the 36px
            button inside the header band and clear of its bottom border —
            at top-3 it spanned 12–48px and crossed the line, which sits at
            46px on /graph and 48px on the /people tab strip. */}
        <div className="absolute right-3 top-1.5 z-30 hidden md:block">
          <ActivityMenu />
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
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        connections={connections}
        setup={setup}
      />
    </ShellContext.Provider>
  );
}
