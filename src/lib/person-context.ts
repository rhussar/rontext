/**
 * Everything an agent needs about one person before writing to them or about
 * them, in one call — the MCP `get_person_context` tool.
 *
 * It exists because drafting well took five or six tool calls (get_contact,
 * intro_paths, the conversation, the owner's past drafts for voice...) and an
 * agent that skipped one wrote a worse message without knowing it.
 *
 * Gated on fresh syncs, by the owner's decision: a context pack that silently
 * lacks this week's texts or meetings is worse than none, because the agent
 * would write "it's been a while!" to someone you saw yesterday. So unless
 * the Messages sync (Mac) and the Google Calendar sync have both succeeded
 * within SYNC_MAX_AGE_HOURS, the tool refuses and says what to fix.
 */

import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  contactEntities,
  contactEnrichment,
  drafts,
  entities,
  groups,
  interactions,
  jobRuns,
  meetingContacts,
  meetings,
  threadSummaries,
  type JobKey,
} from "@/db/schema";
import { getContactDetail } from "@/lib/actions/contacts";
import { introPaths } from "@/lib/intros";
import { openFollowUpsFor } from "@/lib/follow-ups";

/** The Mac agent and the daily cron both run about once a day; allow a missed night. */
export const SYNC_MAX_AGE_HOURS = 48;

const REQUIRED_SYNCS: { job: JobKey; label: string; fix: string }[] = [
  {
    job: "messages",
    label: "Messages (iMessage/SMS)",
    fix: "runs nightly on the Mac via the launchd agent — check the Mac is on and the agent has Full Disk Access (Settings → Connections → Messages)",
  },
  {
    job: "google-calendar",
    label: "Google Calendar",
    fix: "reconnect Google with Calendar access in Settings → Connections → Google, then Sync now",
  },
];

export type SyncGate = {
  ok: boolean;
  syncs: { source: string; lastOkAt: string | null; ageHours: number | null; ok: boolean; problem?: string }[];
};

export async function checkRequiredSyncs(): Promise<SyncGate> {
  const db = getDb();
  const rows = await db
    .select({
      job: jobRuns.job,
      status: jobRuns.status,
      message: jobRuns.message,
      startedAt: jobRuns.startedAt,
    })
    .from(jobRuns)
    .where(inArray(jobRuns.job, REQUIRED_SYNCS.map((r) => r.job)))
    .orderBy(desc(jobRuns.startedAt))
    .limit(200);

  const syncs = REQUIRED_SYNCS.map(({ job, label, fix }) => {
    const mine = rows.filter((r) => r.job === job);
    const lastOk = mine.find((r) => r.status === "ok");
    const latest = mine[0];
    const ageHours = lastOk ? (Date.now() - lastOk.startedAt.getTime()) / 3_600_000 : null;
    const fresh = ageHours !== null && ageHours <= SYNC_MAX_AGE_HOURS;
    let problem: string | undefined;
    if (!fresh) {
      const why = !lastOk
        ? "has never synced successfully"
        : `last synced ${Math.round(ageHours!)}h ago`;
      const lastSaid = latest && latest.status !== "ok" && latest.message ? ` (latest run: ${latest.message})` : "";
      problem = `${label} ${why}${lastSaid} — ${fix}`;
    }
    return {
      source: label,
      lastOkAt: lastOk?.startedAt.toISOString() ?? null,
      ageHours: ageHours === null ? null : Math.round(ageHours),
      ok: fresh,
      ...(problem ? { problem } : {}),
    };
  });
  return { ok: syncs.every((s) => s.ok), syncs };
}

const MAX_NOTE_CHARS = 800;
const MAX_MEETING_CHARS = 1_200;
const VOICE_EXAMPLES = 5;

const clip = (s: string | null | undefined, n: number) =>
  !s ? null : s.length > n ? `${s.slice(0, n)}…` : s;

export async function personContext(contactId: number) {
  const db = getDb();
  const detail = await getContactDetail(contactId);
  if (!detail) return null;
  const c = detail.contact;

  const [
    groupRows,
    companies,
    enrichment,
    channels,
    thread,
    meetingRows,
    voice,
    paths,
    loops,
  ] = await Promise.all([
    detail.groupIds.length
      ? db.select({ name: groups.name }).from(groups).where(inArray(groups.id, detail.groupIds))
      : Promise.resolve([]),
    db
      .selectDistinct({ name: entities.name, role: contactEntities.role })
      .from(contactEntities)
      .innerJoin(entities, eq(entities.id, contactEntities.entityId))
      .where(and(eq(contactEntities.contactId, contactId), eq(entities.type, "company"))),
    db.select().from(contactEnrichment).where(eq(contactEnrichment.contactId, contactId)),
    db.select().from(interactions).where(eq(interactions.contactId, contactId)),
    db.select().from(threadSummaries).where(eq(threadSummaries.contactId, contactId)),
    db
      .select({
        title: meetings.title,
        startedAt: meetings.startedAt,
        summary: meetings.summary,
      })
      .from(meetings)
      .innerJoin(meetingContacts, eq(meetingContacts.meetingId, meetings.id))
      .where(and(eq(meetingContacts.contactId, contactId), isNull(meetings.dismissedAt)))
      .orderBy(desc(meetings.startedAt))
      .limit(3),
    // The owner's own writing to other people — the voice to match. Manual
    // only: agent-written drafts must never become the style reference.
    db
      .select({ channel: drafts.channel, subject: drafts.subject, body: drafts.body })
      .from(drafts)
      .where(and(eq(drafts.source, "manual"), ne(drafts.contactId, contactId), sql`length(${drafts.body}) > 20`))
      .orderBy(desc(drafts.updatedAt))
      .limit(VOICE_EXAMPLES),
    introPaths({ contactId }, 1),
    openFollowUpsFor(contactId),
  ]);
  const path = paths[0];

  const days = (d: string | null) =>
    d ? Math.floor((Date.now() - Date.parse(d)) / 86_400_000) : null;

  return {
    person: {
      id: c.id,
      fullName: c.fullName,
      headline: c.headline,
      title: c.title,
      company: c.company,
      location: c.location,
      hometown: c.hometown,
      birthday: c.birthday,
      emails: c.emails,
      phoneNumbers: c.phoneNumbers,
      linkedinUrl: c.linkedinUrl,
      starred: c.starred,
      groups: groupRows.map((g) => g.name),
      education: detail.education.map((e) =>
        [e.school, e.degree, e.endYear ? `'${String(e.endYear).slice(-2)}` : null].filter(Boolean).join(", "),
      ),
      companies: companies.map((x) => `${x.name}${x.role === "alum" ? " (alum)" : ""}`),
      seniority: enrichment[0]?.seniority ?? null,
      jobFunction: enrichment[0]?.jobFunction ?? null,
    },
    relationship: {
      closeness: path?.direct ?? null,
      lastInteraction: c.lastInteractionDate,
      daysSinceLastInteraction: days(c.lastInteractionDate),
      channels: channels.map((i) => ({
        source: i.source,
        messages: i.messageCount,
        sent: i.sentCount,
        received: i.receivedCount,
        first: i.firstAt,
        last: i.lastAt,
      })),
      recentMonths: detail.periods
        .filter((p) => Date.now() - Date.parse(p.month) < 183 * 86_400_000)
        .map((p) => ({ month: p.month, source: p.source, messages: p.messageCount })),
    },
    conversation: thread.map((t) => ({
      source: t.source,
      ...t.details,
      coversThrough: t.lastMessageAt,
      // Compared against the texts channel only: a newer email or LinkedIn
      // touch doesn't make a *texts* summary out of date.
      stale:
        (channels.find((i) => i.source === "messages")?.lastAt ?? "") >
        t.lastMessageAt.toISOString().slice(0, 10)
          ? "newer texts exist than this summary covers — see the summarize-threads skill"
          : undefined,
    })),
    notes: detail.notes.slice(0, 10).map((n) => ({ at: n.createdAt, body: clip(n.body, MAX_NOTE_CHARS) })),
    meetings: meetingRows.map((m) => ({
      title: m.title,
      at: m.startedAt,
      summary: clip(m.summary, MAX_MEETING_CHARS),
    })),
    recentChanges: detail.changes.slice(0, 5).map((ch) => ({
      field: ch.field,
      from: ch.oldValue,
      to: ch.newValue,
      at: ch.createdAt,
    })),
    // What's owed in either direction, from the follow-ups agent's read of
    // email. Draft to close these before anything else.
    openFollowUps: loops.map((f) => ({
      id: f.id,
      kind: f.kind,
      title: f.title,
      detail: f.detail,
      dueOn: f.dueOn,
      source: f.source,
      asOf: f.lastMessageAt,
    })),
    openReminders: detail.reminders
      .filter((r) => !r.completedAt)
      .map((r) => ({ id: r.id, at: r.remindAt, body: r.body })),
    unsentDrafts: detail.drafts
      .filter((d) => !d.sentAt)
      .map((d) => ({ id: d.id, channel: d.channel, subject: d.subject, body: d.body, source: d.source })),
    peopleWhoKnowThem: (path?.introducers ?? []).map((i) => ({
      id: i.id,
      fullName: i.fullName,
      youAre: i.you.label,
      how: i.howTheyKnowTarget,
    })),
    ownerVoice: voice.map((v) => ({ channel: v.channel, subject: v.subject, body: v.body })),
  };
}

export type PersonContext = NonNullable<Awaited<ReturnType<typeof personContext>>>;
