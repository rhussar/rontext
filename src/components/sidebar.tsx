"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  CircleUser,
  Home,
  MoreHorizontal,
  Notebook,
  PenLine,
  Plus,
  Search,
  Settings,
  Star,
  StickyNote,
  Waypoints,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { deleteGroup, renameGroup } from "@/lib/actions/contacts";
import { useShell, type GroupWithCount } from "@/components/app-shell";
import { WORKSPACE_COLORS, workspaceInitial } from "@/lib/settings";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

function NavItem({
  href,
  icon: Icon,
  label,
  active,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13.5px] transition-colors hover:bg-accent",
        active
          ? "bg-accent/80 font-semibold text-foreground"
          : "font-medium text-foreground/80",
      )}
    >
      {/* The icon carries the weight change too, via stroke — a lucide glyph
          left at 2 next to semibold text reads as the odd one out. */}
      <Icon
        className={cn(
          "size-[17px]",
          active ? "text-foreground" : "text-muted-foreground",
        )}
        strokeWidth={active ? 2.4 : 2}
      />
      {label}
    </Link>
  );
}

export function Sidebar({ groups }: { groups: GroupWithCount[] }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const shell = useShell();
  const activeGroup = pathname === "/people" ? searchParams.get("group") : null;

  return (
    <div className="flex h-full flex-col bg-muted pt-[env(safe-area-inset-top)]">
      {/* Workspace header */}
      <div className="flex items-center gap-2 px-4 pb-2 pt-4">
        <button
          onClick={shell.openSettings}
          aria-label="Workspace settings"
          title="Workspace settings"
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-md transition-transform hover:scale-105",
            WORKSPACE_COLORS[shell.workspaceColor],
          )}
        >
          <span className="text-[11px] font-bold text-white">
            {workspaceInitial(shell.workspaceName)}
          </span>
        </button>
        <span className="truncate text-[13.5px] font-semibold text-foreground">
          {shell.workspaceName}
        </span>
      </div>

      {/* Search */}
      <div className="px-3 pb-3">
        <button
          onClick={shell.openSearch}
          className="flex w-full items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-1.5 text-[13px] text-muted-foreground shadow-xs transition-colors hover:border-input"
        >
          <Search className="size-4" />
          Search
          <kbd className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            ⌘K
          </kbd>
        </button>
      </div>

      {/* Nav */}
      <nav className="flex flex-col gap-0.5 px-3">
        <NavItem href="/" icon={Home} label="Home" active={pathname === "/"} />
        <NavItem
          href="/people"
          icon={CircleUser}
          label="People"
          active={pathname === "/people" && !activeGroup}
        />
        <NavItem
          href="/graph"
          icon={Waypoints}
          label="Network"
          active={pathname === "/graph"}
        />
        <NavItem
          href="/drafts"
          icon={PenLine}
          label="Drafts"
          active={pathname === "/drafts"}
        />
        <NavItem
          href="/notes"
          icon={Notebook}
          label="Notes"
          active={pathname === "/notes"}
        />
      </nav>

      {/* Groups */}
      <div className="mt-6 flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between px-5 pb-1">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Groups
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-5 text-muted-foreground"
            aria-label="New group"
            onClick={shell.openNewGroup}
          >
            <Plus className="size-4" />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto px-3 pb-2">
          <Link
            href="/people?group=starred"
            className={cn(
              "flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13.5px] font-medium text-foreground/80 transition-colors hover:bg-accent",
              activeGroup === "starred" && "bg-accent/80 text-foreground",
            )}
          >
            <Star className="size-[15px] fill-amber-400 text-amber-400" />
            Starred
          </Link>
          {groups.map((g) => (
            <div key={g.id} className="group/row relative">
              <Link
                href={`/people?group=${g.id}`}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13.5px] font-medium text-foreground/80 transition-colors hover:bg-accent",
                  activeGroup === String(g.id) &&
                    "bg-accent/80 text-foreground",
                )}
              >
                <span
                  className="ml-0.5 size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: g.color }}
                />
                <span className="truncate">{g.name}</span>
                <span className="ml-auto pr-1 text-[11px] text-muted-foreground group-hover/row:opacity-0">
                  {g.memberCount}
                </span>
              </Link>
              <div className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover/row:opacity-100">
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6 text-muted-foreground"
                        aria-label={`${g.name} options`}
                      >
                        <MoreHorizontal className="size-3.5" />
                      </Button>
                    }
                  />
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem
                      onClick={() => {
                        const name = window.prompt("Rename group", g.name);
                        if (name && name.trim() && name !== g.name) {
                          renameGroup(g.id, name).then(() =>
                            toast.success(`Renamed to ${name.trim()}`),
                          );
                        }
                      }}
                    >
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => {
                        if (
                          window.confirm(
                            `Delete group "${g.name}"? People in it are not deleted.`,
                          )
                        ) {
                          deleteGroup(g.id).then(() =>
                            toast.success(`Deleted ${g.name}`),
                          );
                        }
                      }}
                    >
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Create new */}
      <div className="flex items-center gap-1 border-t border-border p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <Popover>
          <PopoverTrigger
            render={
              <button className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-2 text-[13.5px] font-medium text-foreground/80 transition-colors hover:bg-accent">
                <Plus className="size-[17px]" />
                Create new
              </button>
            }
          />
          <PopoverContent align="start" side="top" className="w-56 p-1.5">
            <p className="px-2 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Create
            </p>
            <PersonNoteButtons />
          </PopoverContent>
        </Popover>
        <button
          onClick={shell.openSettings}
          aria-label="Settings"
          title="Settings"
          className="shrink-0 rounded-lg p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground/80"
        >
          <Settings className="size-[17px]" />
        </button>
      </div>
    </div>
  );
}

function PersonNoteButtons() {
  const shell = useShell();
  return (
    <div className="flex flex-col">
      <button
        onClick={shell.openNewPerson}
        className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13.5px] text-foreground hover:bg-muted"
      >
        <CircleUser className="size-4 text-muted-foreground" />
        Person
        <kbd className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          P
        </kbd>
      </button>
      <button
        onClick={shell.openNewNote}
        className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13.5px] text-foreground hover:bg-muted"
      >
        <StickyNote className="size-4 text-muted-foreground" />
        Note
        <kbd className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          N
        </kbd>
      </button>
    </div>
  );
}
