"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  CircleUser,
  Home,
  LogOut,
  MoreHorizontal,
  Notebook,
  Plus,
  Search,
  Star,
  StickyNote,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { logout } from "@/lib/actions/auth";
import { deleteGroup, renameGroup } from "@/lib/actions/contacts";
import { useShell, type GroupWithCount } from "@/components/app-shell";
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
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13.5px] font-medium text-stone-600 transition-colors hover:bg-stone-200/60",
        active && "bg-stone-200/80 text-stone-900",
      )}
    >
      <Icon className="size-[17px] text-stone-500" />
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
    <div className="flex h-full flex-col bg-stone-100 pt-[env(safe-area-inset-top)]">
      {/* Workspace header */}
      <div className="flex items-center gap-2 px-4 pb-2 pt-4">
        <div className="flex size-6 items-center justify-center rounded-md bg-gradient-to-br from-emerald-300 via-sky-300 to-violet-300">
          <span className="text-[11px] font-bold text-white">M</span>
        </div>
        <span className="text-[13.5px] font-semibold text-stone-800">
          My Workspace
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="ml-auto size-6 text-stone-400"
                aria-label="Workspace menu"
              >
                <MoreHorizontal className="size-4" />
              </Button>
            }
          />
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => logout()}>
              <LogOut className="size-4" /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Search */}
      <div className="px-3 pb-3">
        <button
          onClick={shell.openSearch}
          className="flex w-full items-center gap-2 rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-400 shadow-xs transition-colors hover:border-stone-300"
        >
          <Search className="size-4" />
          Search
          <kbd className="ml-auto rounded bg-stone-100 px-1.5 py-0.5 text-[10px] font-medium text-stone-400">
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
          href="/notes"
          icon={Notebook}
          label="Notes"
          active={pathname === "/notes"}
        />
        <NavItem
          href="/import"
          icon={Upload}
          label="Import"
          active={pathname === "/import"}
        />
      </nav>

      {/* Groups */}
      <div className="mt-6 flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between px-5 pb-1">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-stone-400">
            Groups
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-5 text-stone-400"
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
              "flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13.5px] font-medium text-stone-600 transition-colors hover:bg-stone-200/60",
              activeGroup === "starred" && "bg-stone-200/80 text-stone-900",
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
                  "flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13.5px] font-medium text-stone-600 transition-colors hover:bg-stone-200/60",
                  activeGroup === String(g.id) &&
                    "bg-stone-200/80 text-stone-900",
                )}
              >
                <span
                  className="ml-0.5 size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: g.color }}
                />
                <span className="truncate">{g.name}</span>
                <span className="ml-auto pr-1 text-[11px] text-stone-400 group-hover/row:opacity-0">
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
                        className="size-6 text-stone-400"
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
      <div className="border-t border-stone-200 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <Popover>
          <PopoverTrigger
            render={
              <button className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[13.5px] font-medium text-stone-600 transition-colors hover:bg-stone-200/60">
                <Plus className="size-[17px]" />
                Create new
              </button>
            }
          />
          <PopoverContent align="start" side="top" className="w-56 p-1.5">
            <p className="px-2 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wider text-stone-400">
              Create
            </p>
            <PersonNoteButtons />
          </PopoverContent>
        </Popover>
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
        className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13.5px] text-stone-700 hover:bg-stone-100"
      >
        <CircleUser className="size-4 text-stone-500" />
        Person
        <kbd className="ml-auto rounded bg-stone-100 px-1.5 py-0.5 text-[10px] text-stone-400">
          P
        </kbd>
      </button>
      <button
        onClick={shell.openNewNote}
        className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13.5px] text-stone-700 hover:bg-stone-100"
      >
        <StickyNote className="size-4 text-stone-500" />
        Note
        <kbd className="ml-auto rounded bg-stone-100 px-1.5 py-0.5 text-[10px] text-stone-400">
          N
        </kbd>
      </button>
    </div>
  );
}
