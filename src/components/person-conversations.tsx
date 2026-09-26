"use client";

import { MessageCircle, MessageSquare } from "lucide-react";
import { format } from "date-fns";
import type { ContactDetail, ContactThreadSummary } from "@/lib/actions/contacts";

const SOURCE: Record<
  ContactThreadSummary["source"],
  { label: string; icon: typeof MessageSquare; period: "messages" | "whatsapp" }
> = {
  imessage: { label: "Texts", icon: MessageSquare, period: "messages" },
  whatsapp: { label: "WhatsApp", icon: MessageCircle, period: "whatsapp" },
};

/**
 * What you and this person talk about, per 1:1 thread — the same summaries
 * agents get from get_person_context. Rontext never writes these itself: an
 * agent reads the thread on the Mac (summarize-threads skill) and saves one.
 * The raw messages never leave the Mac, so this is all there is to show.
 */
export function PersonConversations({ detail }: { detail: ContactDetail }) {
  const { threads, periods } = detail;
  const texted = periods.some((p) => p.source === "messages" || p.source === "whatsapp");
  if (!threads.length && !texted) return null;

  return (
    <section>
      <p className="pb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Conversations
      </p>
      {threads.length ? (
        <div className="flex flex-col gap-3">
          {threads.map((t) => (
            <ThreadCard key={t.source} thread={t} periods={periods} />
          ))}
        </div>
      ) : (
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          No summary yet. Ask an agent to &ldquo;summarize my texts with{" "}
          {detail.contact.firstName ?? detail.contact.fullName}&rdquo; and it will appear here.
        </p>
      )}
    </section>
  );
}

function ThreadCard({
  thread: t,
  periods,
}: {
  thread: ContactThreadSummary;
  periods: ContactDetail["periods"];
}) {
  const src = SOURCE[t.source];
  const Icon = src.icon;
  const d = t.details;
  // Month granularity is all the monthly buckets can say, which is enough to
  // flag a summary that a whole later month of messages has overtaken.
  const coveredMonth = format(t.lastMessageAt, "yyyy-MM");
  const newer = periods.some((p) => p.source === src.period && p.month.slice(0, 7) > coveredMonth);

  return (
    <div className="rounded-lg border border-border px-3.5 py-3">
      <div className="flex items-center gap-2 pb-1.5 text-[12px] text-muted-foreground">
        <Icon className="size-3.5 shrink-0" />
        <span className="font-medium text-foreground">{src.label}</span>
        <span>
          · {t.messagesCovered} messages through {format(t.lastMessageAt, "MMM d, yyyy")}
        </span>
      </div>
      <p className="text-[13.5px] leading-relaxed text-foreground">{d.overview}</p>
      {d.lastTopic ? (
        <p className="pt-2 text-[13px] leading-relaxed text-foreground">
          <span className="text-muted-foreground">Most recently: </span>
          {d.lastTopic}
        </p>
      ) : null}
      <Bullets label="Open loops" items={d.openLoops} />
      <Bullets label="Their news" items={d.personalDetails} />
      {d.tone ? (
        <p className="pt-2 text-[13px] leading-relaxed text-foreground">
          <span className="text-muted-foreground">Tone: </span>
          {d.tone}
        </p>
      ) : null}
      <p className="pt-2.5 text-[11px] text-muted-foreground">
        Written by {t.model} on {format(t.updatedAt, "MMM d")}
        {newer ? (
          <span className="text-amber-700 dark:text-amber-300">
            {" "}
            · newer {src.label === "Texts" ? "texts" : "WhatsApp messages"} since; ask an agent to refresh it
          </span>
        ) : null}
      </p>
    </div>
  );
}

function Bullets({ label, items }: { label: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="pt-2">
      <p className="text-[12px] text-muted-foreground">{label}</p>
      <ul className="list-disc pl-5 text-[13px] leading-relaxed text-foreground">
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </div>
  );
}
