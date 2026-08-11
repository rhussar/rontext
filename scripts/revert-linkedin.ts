/**
 * Undo everything the LinkedIn sync feature wrote to the database.
 *
 *   set -a && source .env.local && set +a && npx tsx scripts/revert-linkedin.ts [flags]
 *
 * Flags:
 *   --dry-run        Show what would happen, change nothing.
 *   --all-linkedin   Roll back every source="linkedin" change and delete
 *                    contacts the scraper created. (default action)
 *   --photos         Also delete photos this scraper saved (source="linkedin").
 *                    Hand-uploaded, vCard and unavatar-backfilled photos are
 *                    left alone — to drop those, see backfill-photos.ts --revert.
 *
 * FULL TEARDOWN of the feature:
 *   1. npx tsx scripts/revert-linkedin.ts --all-linkedin --photos
 *   2. In Postgres:
 *        DROP TABLE contact_photos;
 *        DROP TABLE contact_changes;
 *        DROP TABLE scrape_runs;
 *        ALTER TABLE contacts DROP COLUMN headline, DROP COLUMN last_scraped_at;
 *   3. git revert the LinkedIn-sync commits, then `vercel deploy --prod --yes`.
 * All schema changes were additive, so this restores the exact prior state.
 */
import { asc, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { contactChanges, contactPhotos, contacts, scrapeRuns } from "../src/db/schema";

const REVERTIBLE_FIELDS = new Set([
  "headline",
  "title",
  "company",
  "location",
  "linkedinUrl",
  "fullName",
]);

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const wipePhotos = args.includes("--photos");
  const db = getDb();
  const log = (msg: string) => console.log(`${dryRun ? "[dry-run] " : ""}${msg}`);

  // 1. Contacts the scraper created — delete outright (cascades changes + photos)
  const created = await db
    .select({ id: contacts.id, fullName: contacts.fullName })
    .from(contacts)
    .where(eq(contacts.source, "linkedin"));
  log(`Contacts created by scraping: ${created.length}`);
  for (const c of created) log(`  delete contact #${c.id} ${c.fullName}`);

  const createdIds = new Set(created.map((c) => c.id));

  // 2. Roll back linkedin-sourced field changes on pre-existing contacts,
  //    newest first so the oldest recorded oldValue wins.
  const changes = await db
    .select()
    .from(contactChanges)
    .where(eq(contactChanges.source, "linkedin"))
    .orderBy(desc(contactChanges.createdAt), desc(contactChanges.id));

  const toRevert = changes.filter(
    (ch) => !createdIds.has(ch.contactId) && REVERTIBLE_FIELDS.has(ch.field),
  );
  log(`LinkedIn changes to roll back: ${toRevert.length}`);

  if (!dryRun) {
    for (const ch of toRevert) {
      await db
        .update(contacts)
        .set({ [ch.field]: ch.oldValue, updatedAt: new Date() })
        .where(eq(contacts.id, ch.contactId));
    }
    // Delete all linkedin change rows (including "connected" markers)
    const ids = changes.map((c) => c.id).filter((id) => id != null);
    for (let i = 0; i < ids.length; i += 200) {
      await db.delete(contactChanges).where(inArray(contactChanges.id, ids.slice(i, i + 200)));
    }
    if (created.length) {
      await db.delete(contacts).where(
        inArray(contacts.id, [...createdIds]),
      );
    }
    // Clear lastScrapedAt so a future sync starts fresh
    await db.update(contacts).set({ lastScrapedAt: null });
    await db.delete(scrapeRuns);
  } else {
    for (const ch of toRevert) {
      log(`  contact #${ch.contactId}: ${ch.field} "${ch.newValue}" -> "${ch.oldValue}"`);
    }
  }

  if (wipePhotos) {
    // Scoped to source="linkedin" on purpose. contact_photos also holds photos
    // uploaded by hand, pulled from a vCard import, and written by the unavatar
    // backfill; an unfiltered delete here would take all of those with it.
    // To drop the backfill instead, use scripts/backfill-photos.ts --revert.
    const photos = await db
      .select({ contactId: contactPhotos.contactId })
      .from(contactPhotos)
      .where(eq(contactPhotos.source, "linkedin"));
    log(`Scraped photos to delete: ${photos.length}`);
    if (!dryRun) await db.delete(contactPhotos).where(eq(contactPhotos.source, "linkedin"));
  }

  log("Done.");
}

main();
