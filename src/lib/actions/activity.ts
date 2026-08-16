"use server";

import { desc, eq, isNull, ne } from "drizzle-orm";
import { getDb } from "@/db";
import {
  appState,
  contactChanges,
  contacts,
  imports,
  scrapeRuns,
  syncRuns,
} from "@/db/schema";
import { CHANGE_FIELD_LABELS, displayName, roleLine } from "@/lib/format";

const SEEN_KEY = "activity_seen_at";

export type ActivityItem = {
  id: string;
  /** Headline, e.g. "Teddy Schwarz was added" */
  title: string;
  /** Small caps suffix after the timestamp, e.g. "VIA LINKEDIN" */
  via: string | null;
  /** Optional second line, e.g. "Engineer → Staff Engineer" */
  detail: string | null;
  /** Set for headline changes, which render as a word-level diff */
  diff: {
    oldValue: string | null;
    newValue: string | null;
    previousRole: string | null;
  } | null;
  /** Set when the row should link through to a person */
  contactId: number | null;
  createdAt: string;
};

const SOURCE_LABELS: Record<string, string> = {
  import: "VIA CSV IMPORT",
  manual: "VIA MANUAL ADDITION",
  linkedin: "VIA LINKEDIN",
  gmail: "VIA GMAIL",
  messages: "VIA MESSAGES",
};

const CONNECTOR_LABELS: Record<string, string> = {
  gmail: "Gmail",
  messages: "Messages",
};

/**
 * One feed over five sources: contacts added, field changes, CSV imports,
 * LinkedIn scrapes and Gmail/Messages syncs. Each source is capped, merged,
 * then sorted — cheaper than a UNION and keeps the shaping in one readable
 * place.
 */
export async function listActivity(limit = 60): Promise<ActivityItem[]> {
  const db = getDb();

  const [added, changes, importRuns, linkedinRuns, connectorRuns] = await Promise.all([
    db
      .select({
        id: contacts.id,
        fullName: contacts.fullName,
        source: contacts.source,
        createdAt: contacts.createdAt,
      })
      .from(contacts)
      .where(isNull(contacts.archivedAt))
      .orderBy(desc(contacts.createdAt))
      .limit(limit),
    db
      .select({
        id: contactChanges.id,
        contactId: contactChanges.contactId,
        contactName: contacts.fullName,
        // Baseline for headline rows whose oldValue is null — see HeadlineDiff
        title: contacts.title,
        company: contacts.company,
        field: contactChanges.field,
        oldValue: contactChanges.oldValue,
        newValue: contactChanges.newValue,
        source: contactChanges.source,
        createdAt: contactChanges.createdAt,
      })
      .from(contactChanges)
      // "connected" duplicates the contact-added row for LinkedIn people
      .where(ne(contactChanges.field, "connected"))
      .innerJoin(contacts, eq(contactChanges.contactId, contacts.id))
      .orderBy(desc(contactChanges.createdAt))
      .limit(limit),
    db.select().from(imports).orderBy(desc(imports.createdAt)).limit(10),
    db.select().from(scrapeRuns).orderBy(desc(scrapeRuns.createdAt)).limit(10),
    db.select().from(syncRuns).orderBy(desc(syncRuns.createdAt)).limit(10),
  ]);

  const items: ActivityItem[] = [
    ...added.map((c) => ({
      id: `contact-${c.id}`,
      title: `${displayName(c.fullName)} was added`,
      via: SOURCE_LABELS[c.source] ?? null,
      detail: null,
      diff: null,
      contactId: c.id,
      createdAt: c.createdAt.toISOString(),
    })),
    ...changes.map((ch) => ({
      id: `change-${ch.id}`,
      title: `${displayName(ch.contactName)}'s ${(
        CHANGE_FIELD_LABELS[ch.field] ?? ch.field
      ).toLowerCase()} changed`,
      via: SOURCE_LABELS[ch.source] ?? null,
      // Headline rows render as a diff, so they carry the raw values instead
      detail: ch.field === "headline" ? null : `${ch.oldValue ?? "—"} → ${ch.newValue ?? "—"}`,
      diff:
        ch.field === "headline"
          ? {
              oldValue: ch.oldValue,
              newValue: ch.newValue,
              previousRole: roleLine(ch.title, ch.company),
            }
          : null,
      contactId: ch.contactId,
      createdAt: ch.createdAt.toISOString(),
    })),
    ...importRuns.map((r) => ({
      id: `import-${r.id}`,
      title:
        r.createdCount > 0
          ? `${r.createdCount.toLocaleString()} contacts imported`
          : `Import run — ${r.updatedCount.toLocaleString()} updated`,
      via: "VIA CSV IMPORT",
      detail: r.filename,
      diff: null,
      contactId: null,
      createdAt: r.createdAt.toISOString(),
    })),
    ...linkedinRuns
      // A sync that found nothing isn't news
      .filter((r) => r.createdCount + r.updatedCount > 0)
      .map((r) => {
        // The two LinkedIn paths are different enough to read as different
        // events: the skill runs a batch on demand and may create contacts,
        // while the extension folds a whole day of Chrome captures into this
        // one row and never creates anyone. Rendering both as "LinkedIn sync"
        // made a day of extension work look like a Claude run.
        const viaExtension = r.source === "extension";
        return {
          id: `sync-${r.id}`,
          title: viaExtension
            ? `${r.updatedCount} ${r.updatedCount === 1 ? "person" : "people"} updated from LinkedIn`
            : `LinkedIn sync — ${r.createdCount} new, ${r.updatedCount} updated`,
          via: viaExtension ? "VIA CHROME EXTENSION" : "VIA LINKEDIN",
          detail: viaExtension
            ? `${r.profileCount} profile${r.profileCount === 1 ? "" : "s"} visited in Chrome · ${r.changeCount} change${r.changeCount === 1 ? "" : "s"}`
            : `${r.profileCount} profile${r.profileCount === 1 ? "" : "s"} checked`,
          diff: null,
          contactId: null,
          createdAt: r.createdAt.toISOString(),
        };
      }),
    ...connectorRuns
      .filter((r) => r.enriched + r.candidates > 0)
      .map((r) => ({
        id: `connector-${r.id}`,
        title: `${CONNECTOR_LABELS[r.connector] ?? r.connector} sync — ${r.enriched} updated, ${r.candidates} to review`,
        via: SOURCE_LABELS[r.connector] ?? null,
        detail: `${r.matched.toLocaleString()} of ${r.scanned.toLocaleString()} matched a contact`,
        diff: null,
        contactId: null,
        createdAt: r.createdAt.toISOString(),
      })),
  ];

  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return items.slice(0, limit);
}

/**
 * On a fresh install every historical row would otherwise count as unread, so
 * the first read seeds the marker to now — you start at zero and only see
 * genuinely new activity from then on.
 */
export async function getActivitySeenAt(): Promise<string | null> {
  const db = getDb();
  const [row] = await db.select().from(appState).where(eq(appState.key, SEEN_KEY));
  if (row) return row.value;
  const now = new Date().toISOString();
  await db
    .insert(appState)
    .values({ key: SEEN_KEY, value: now })
    .onConflictDoNothing();
  return now;
}

export async function markActivitySeen(): Promise<void> {
  const db = getDb();
  const now = new Date();
  await db
    .insert(appState)
    .values({ key: SEEN_KEY, value: now.toISOString(), updatedAt: now })
    .onConflictDoUpdate({
      target: appState.key,
      set: { value: now.toISOString(), updatedAt: now },
    });
}
