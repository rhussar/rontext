"use client";

import { SlidersHorizontal } from "lucide-react";
import { CompanyLogoSection } from "@/components/graph/logo-controls";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/**
 * The Network view's single control surface: what the graph currently holds,
 * and the knobs for how it looks.
 *
 * The counts used to sit in the header beside the title, where they were
 * permanent chrome for a number you read once. Parked in here they stay one
 * click away without competing with the canvas.
 */
export function NetworkSettings({
  people,
  companies,
  unconnected,
}: {
  people: number;
  companies: number;
  unconnected: number;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            aria-label="Network settings"
            title="Network settings"
            /* Floating over the canvas, so it needs its own surface: a solid
               background, a hairline border and a shadow lift it off the
               graph, where a flat tint would read as just another node. */
            className="flex size-9 items-center justify-center rounded-lg border border-border bg-background/90 text-muted-foreground shadow-xs backdrop-blur-sm transition-colors hover:bg-muted hover:text-foreground"
          >
            <SlidersHorizontal className="size-4" />
          </button>
        }
      />
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[360px] max-w-[calc(100vw-1.5rem)] p-0"
      >
        <div className="border-b border-border bg-muted/50 px-4 py-2.5">
          <p className="text-[11.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Network
          </p>
        </div>

        <dl className="border-b border-border px-4 py-2.5">
          <Stat label="People" value={people} />
          <Stat label="Companies" value={companies} />
          <Stat
            label="No shared employer"
            value={unconnected}
            hint="These contacts share no employer with anyone else in your network, so there's nothing to connect them to yet."
            muted
          />
        </dl>

        <div className="border-b border-border bg-muted/50 px-4 py-2.5">
          <p className="text-[11.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Company logos
          </p>
        </div>
        <CompanyLogoSection />
      </PopoverContent>
    </Popover>
  );
}

function Stat({
  label,
  value,
  hint,
  muted,
}: {
  label: string;
  value: number;
  hint?: string;
  muted?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5" title={hint}>
      <dt className={`text-[13px] ${muted ? "text-muted-foreground" : "text-foreground"}`}>
        {label}
      </dt>
      <dd
        className={`text-[13px] tabular-nums ${muted ? "text-muted-foreground" : "font-medium text-foreground"}`}
      >
        {value.toLocaleString()}
      </dd>
    </div>
  );
}
