/**
 * Google Calendar → meetings as interactions. The headline Mesh feature the
 * Gmail/Messages connectors couldn't give: "last met 3 weeks ago" alongside
 * "last emailed".
 *
 * Reads past events on the primary calendar and counts, per attendee email,
 * one interaction per meeting — same HandleAggregate shape as Gmail, same
 * ingestHandles() path, same candidates queue for people you meet who aren't
 * in the CRM. Titles, descriptions and locations are never requested
 * (`fields=` trims the response to attendees + times) and never stored:
 * counts and dates only, like every connector.
 *
 * Filters that keep it people-shaped: events I declined, attendees who
 * declined, room/resource attendees, and anything with more than
 * MAX_ATTENDEES (all-hands, webinars — nobody "met" 80 people).
 *
 * Window is the same calendar-aligned rolling one Gmail uses (first of the
 * previous month; 12-month baseline on the first run) for the same greatest()
 * reason.
 */
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { syncRuns } from "@/db/schema";
import type { PeriodTally } from "@/db/schema";
import { ingestHandles, type HandleAggregate } from "@/lib/connector-ingest";
import { monthStart } from "@/lib/gmail-sync";
import {
  CALENDAR_API,
  fetchGmailAddress,
  getGoogleCredentials,
  googleGet,
  hasScope,
  refreshAccessToken,
} from "@/lib/google-auth";
import type { JobContext, JobResult } from "./registry";

const MAX_ATTENDEES = 15;
const BASELINE_MONTHS = 12;

type Attendee = {
  email?: string;
  displayName?: string;
  self?: boolean;
  resource?: boolean;
  responseStatus?: "needsAction" | "declined" | "tentative" | "accepted";
};
type Event = {
  id: string;
  status?: string;
  start?: { dateTime?: string; date?: string };
  attendees?: Attendee[];
};
type Page = { items?: Event[]; nextPageToken?: string };

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const month = (ms: number) => iso(ms).slice(0, 7) + "-01";

export async function googleCalendarJob(ctx: JobContext): Promise<JobResult> {
  const creds = await getGoogleCredentials();
  if (!creds) {
    return { status: "skipped", message: "Google not connected — Settings → Accounts → Connect Google" };
  }
  if (!hasScope(creds, "calendar")) {
    return { status: "skipped", message: "Grant doesn't include Calendar — reconnect Google to add it" };
  }
  const token = await refreshAccessToken(creds);
  const me = (creds.email ?? (await fetchGmailAddress(token)) ?? "").toLowerCase();

  const [prior] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(syncRuns)
    .where(sql`${syncRuns.connector} = 'calendar'`);
  const baseline = (prior?.n ?? 0) === 0;
  const since = baseline
    ? new Date(Date.now() - BASELINE_MONTHS * 30 * 86_400_000).toISOString()
    : `${monthStart(1)}T00:00:00Z`;
  const now = new Date().toISOString();

  type Tally = {
    handle: string;
    displayName: string | null;
    meetings: number;
    first: number;
    last: number;
    months: Map<string, PeriodTally>;
  };
  const tallies = new Map<string, Tally>();
  let events = 0;
  let counted = 0;
  let pageToken: string | undefined;
  let truncated = false;

  do {
    if (Date.now() > ctx.deadline - 15_000) {
      truncated = true;
      break;
    }
    const page = await googleGet<Page>(token, `${CALENDAR_API}/calendars/primary/events`, {
      timeMin: since,
      timeMax: now,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "2500",
      // Ask for exactly what we use — no summary, description or location.
      fields: "nextPageToken,items(id,status,start,attendees(email,displayName,self,resource,responseStatus))",
      ...(pageToken ? { pageToken } : {}),
    });
    for (const ev of page.items ?? []) {
      events++;
      if (ev.status === "cancelled") continue;
      const startRaw = ev.start?.dateTime ?? ev.start?.date;
      if (!startRaw) continue;
      const ts = Date.parse(startRaw);
      if (!Number.isFinite(ts)) continue;
      const attendees = (ev.attendees ?? []).filter((a) => a.email && !a.resource);
      if (!attendees.length || attendees.length > MAX_ATTENDEES) continue;
      const mine = attendees.find((a) => a.self || a.email!.toLowerCase() === me);
      if (mine?.responseStatus === "declined") continue;
      let any = false;
      for (const a of attendees) {
        const email = a.email!.toLowerCase();
        if (a.self || email === me) continue;
        if (a.responseStatus === "declined") continue;
        any = true;
        const t = tallies.get(email) ?? {
          handle: email,
          displayName: null,
          meetings: 0,
          first: ts,
          last: ts,
          months: new Map<string, PeriodTally>(),
        };
        t.meetings++;
        if (!t.displayName && a.displayName) t.displayName = a.displayName;
        if (ts < t.first) t.first = ts;
        if (ts > t.last) t.last = ts;
        const key = month(ts);
        const b = t.months.get(key) ?? { month: key, messageCount: 0, sentCount: 0, receivedCount: 0 };
        b.messageCount++;
        b.sentCount++;
        t.months.set(key, b);
        tallies.set(email, t);
      }
      if (any) counted++;
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  ctx.log(`  ${events} events read, ${counted} meetings with people, ${tallies.size} attendees`);

  // A meeting is two-way by definition, so it's recorded on the "sent" side
  // (isConversation needs sentCount ≥ 1); receivedCount stays 0 so the sum
  // still equals the meeting count.
  const rows: HandleAggregate[] = [...tallies.values()].map((t) => ({
    handle: t.handle,
    displayName: t.displayName,
    messageCount: t.meetings,
    sentCount: t.meetings,
    receivedCount: 0,
    firstAt: iso(t.first),
    lastAt: iso(t.last),
    periods: truncated ? undefined : [...t.months.values()].sort((a, b) => a.month.localeCompare(b.month)),
  }));

  const s = await ingestHandles("calendar", "calendar", rows, {
    minMessages: 1,
    candidateMinMessages: 2,
  });
  if (!s.ok) throw new Error(s.error ?? "Calendar ingest failed");

  return {
    status: "ok",
    message:
      `${baseline ? `last ${BASELINE_MONTHS} months` : `since ${monthStart(1)}`} · ${counted} meetings · ` +
      `${s.matched} people matched` +
      (s.candidatesNew ? ` · ${s.candidatesNew} new to review` : "") +
      (truncated ? " · truncated (time budget), buckets skipped" : ""),
    summary: {
      baseline,
      events,
      meetings: counted,
      attendees: tallies.size,
      matched: s.matched,
      candidatesNew: s.candidatesNew,
      periods: s.periods,
      truncated,
    },
  };
}
