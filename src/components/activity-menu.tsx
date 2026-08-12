"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, ChevronsUpDown, LogOut } from "lucide-react";
import { cn } from "@/lib/utils";
import { logout } from "@/lib/actions/auth";
import {
  getActivitySeenAt,
  listActivity,
  markActivitySeen,
  type ActivityItem,
} from "@/lib/actions/activity";
import { HeadlineDiff } from "@/components/headline-diff";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

const COLLAPSED_COUNT = 6;

/** "6D AGO", "3H AGO", "JUST NOW" — the compact Mesh timestamp. */
function shortAgo(iso: string, now: number): string {
  const secs = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (secs < 60) return "JUST NOW";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}M AGO`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}H AGO`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}D AGO`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}MO AGO`;
  return `${Math.floor(months / 12)}Y AGO`;
}

function bucketOf(iso: string, now: number): string {
  const days = (now - new Date(iso).getTime()) / 86_400_000;
  if (days < 1) return "TODAY";
  if (days < 7) return "THIS WEEK";
  if (days < 14) return "LAST WEEK";
  if (days < 60) return "LAST MONTH";
  return "EARLIER";
}

export function ActivityMenu() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [seenAt, setSeenAt] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  // Frozen per render pass so relative labels can't drift between server and
  // client — the same reason reminders compute `overdue` server-side.
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([listActivity(), getActivitySeenAt()]).then(([a, s]) => {
      if (!alive) return;
      setItems(a);
      setSeenAt(s);
      setNow(Date.now());
    });
    return () => {
      alive = false;
    };
  }, []);

  const unread =
    items && now
      ? items.filter((i) => !seenAt || i.createdAt > seenAt).length
      : 0;

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setNow(Date.now());
      // Mark read on close so the "N unread" count stays visible while reading
      return;
    }
    if (unread > 0) {
      markActivitySeen().then(() => setSeenAt(new Date().toISOString()));
    }
    setExpanded(false);
  }

  const visible = items
    ? expanded
      ? items
      : items.slice(0, COLLAPSED_COUNT)
    : [];

  // Group consecutive items under their bucket heading
  const groups: { label: string; items: ActivityItem[] }[] = [];
  if (now) {
    for (const item of visible) {
      const label = bucketOf(item.createdAt, now);
      const last = groups[groups.length - 1];
      if (last && last.label === label) last.items.push(item);
      else groups.push({ label, items: [item] });
    }
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <button
            aria-label={
              unread > 0 ? `Notifications, ${unread} unread` : "Notifications"
            }
            className="relative flex size-9 items-center justify-center rounded-full bg-muted-foreground/20 text-muted-foreground transition-colors hover:bg-muted-foreground/30"
          >
            <Bell className="size-4" />
            {unread > 0 ? (
              <span className="absolute right-0 top-0 size-2.5 rounded-full border-2 border-border bg-blue-500" />
            ) : null}
          </button>
        }
      />
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[360px] max-w-[calc(100vw-1.5rem)] p-0"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border bg-muted/50 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <span className="text-[11.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Rontext
            </span>
          </div>
          <span className="text-[11.5px] tabular-nums text-muted-foreground">
            {process.env.NEXT_PUBLIC_APP_VERSION ?? "0.1.0"}
          </span>
        </div>

        {/* Activity */}
        <div className="max-h-[min(60vh,26rem)] overflow-y-auto px-4 py-1">
          {!items || !now ? (
            <div className="flex flex-col gap-3 py-3">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-3/5" />
            </div>
          ) : items.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-muted-foreground">
              No activity yet. Import contacts or run a LinkedIn sync.
            </p>
          ) : (
            groups.map((group) => (
              <section key={group.label + group.items[0].id}>
                <h3 className="border-b border-border pb-1.5 pt-3 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                  {group.label}
                </h3>
                <ul>
                  {group.items.map((item) => (
                    <ActivityRow
                      key={item.id}
                      item={item}
                      now={now}
                      unread={!seenAt || item.createdAt > seenAt}
                      onNavigate={() => setOpen(false)}
                    />
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>

        {/* Footer */}
        {items && items.length > COLLAPSED_COUNT ? (
          <div className="flex items-center gap-2 border-t border-border px-4 py-2">
            <button
              onClick={() => setExpanded((e) => !e)}
              className="flex items-center gap-1.5 text-[11.5px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground"
            >
              <ChevronsUpDown className="size-3.5" />
              {expanded ? "Show less" : "See all"}
            </button>
            {unread > 0 ? (
              <span className="rounded bg-blue-50 dark:bg-blue-950/40 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-400">
                {unread} unread
              </span>
            ) : null}
          </div>
        ) : null}

        <div className="border-t border-border">
          <button
            onClick={() => logout()}
            className="flex w-full items-center gap-2.5 px-4 py-2.5 text-[13.5px] text-muted-foreground hover:bg-muted/50"
          >
            <LogOut className="size-4 text-muted-foreground" />
            Sign out
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ActivityRow({
  item,
  now,
  unread,
  onNavigate,
}: {
  item: ActivityItem;
  now: number;
  unread: boolean;
  onNavigate: () => void;
}) {
  const router = useRouter();
  const clickable = item.contactId != null;

  return (
    <li className="group/row relative pl-5">
      {/* Timeline rail — hidden on the last row so it doesn't dangle */}
      <span className="absolute left-[3px] top-[15px] h-full w-px bg-muted-foreground/20 group-last/row:hidden" />
      <span
        className={cn(
          "absolute left-0 top-[11px] size-[7px] rounded-full",
          unread ? "bg-blue-500" : "bg-muted-foreground/30",
        )}
      />
      <button
        disabled={!clickable}
        onClick={() => {
          if (!clickable) return;
          onNavigate();
          router.push(`/people?person=${item.contactId}`);
        }}
        className={cn(
          "-mx-2 block w-[calc(100%+1rem)] rounded px-2 py-1.5 text-left",
          clickable && "hover:bg-muted/50",
        )}
      >
        <p className="text-[13.5px] leading-snug text-foreground">{item.title}</p>
        <p className="pt-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
          {shortAgo(item.createdAt, now)}
          {item.via ? ` • ${item.via}` : ""}
        </p>
        {item.diff ? (
          <div className="pt-1">
            <HeadlineDiff
              oldValue={item.diff.oldValue}
              newValue={item.diff.newValue}
              previousRole={item.diff.previousRole}
              className="text-[12px]"
            />
          </div>
        ) : item.detail ? (
          <p className="truncate pt-0.5 text-[12px] text-muted-foreground">
            {item.detail}
          </p>
        ) : null}
      </button>
    </li>
  );
}
