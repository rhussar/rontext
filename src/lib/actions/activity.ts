"use server";

import { desc, eq, isNull, ne } from "drizzle-orm";
import { getDb } from "@/db";
import {
  appState,
  contactChanges,
  contacts,
  imports,
  scrapeRuns,
} from "@/db/schema";
import { CHANGE_FIELD_LABELS } from "@/lib/format";

const SEEN_KEY = "activity_seen_at";

export type ActivityItem = {
  id: string;
  /** Headline, e.g. "Teddy Schwarz was added" */
  title: string;
  /** Small caps suffix after the timestamp, e.g. "VIA LINKEDIN" */
  via: string | null;
  /** Optional second line, e.g. "Engineer → Staff Engineer" */
  detail: string | null;
  /** Set when the row should link through to a person */
  contactId: number | null;
  createdAt: string;
};

const SOURCE_LABELS: Record<string, string> = {
  import: "VIA CSV IMPORT",
  manual: "VIA MANUAL ADDITION",
  linkedin: "VIA LINKEDIN",
};

/**
 * One feed over four sources: contacts added, field changes, CSV imports and
 * LinkedIn sync runs. Each source is capped, merged, then sorted — cheaper than
 * a UNION and keeps the shaping in one readable place.
 */
export async function listActivity(limit = 60): Promise<ActivityItem[]> {
  const db = getDb();

  const [added, changes, importRuns, syncRuns] = await Promise.all([
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
  ]);

  const items: ActivityItem[] = [
    ...added.map((c) => ({
      id: `contact-${c.id}`,
      title: `${c.fullName} was added`,
      via: SOURCE_LABELS[c.source] ?? null,
      detail: null,
      contactId: c.id,
      createdAt: c.createdAt.toISOString(),
    })),
    ...changes.map((ch) => ({
      id: `change-${ch.id}`,
      title: `${ch.contactName}'s ${(
        CHANGE_FIELD_LABELS[ch.field] ?? ch.field
      ).toLowerCase()} changed`,
      via: ch.source === "linkedin" ? "VIA LINKEDIN" : null,
      detail: `${ch.oldValue ?? "—"} → ${ch.newValue ?? "—"}`,
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
      contactId: null,
      createdAt: r.createdAt.toISOString(),
    })),
    ...syncRuns
      // A sync that found nothing isn't news
      .filter((r) => r.createdCount + r.updatedCount > 0)
      .map((r) => ({
        id: `sync-${r.id}`,
        title: `LinkedIn sync — ${r.createdCount} new, ${r.updatedCount} updated`,
        via: "VIA LINKEDIN",
        detail: `${r.profileCount} profile${r.profileCount === 1 ? "" : "s"} checked`,
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
