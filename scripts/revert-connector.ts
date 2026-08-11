/**
 * Undo everything the Gmail or Messages connector wrote to the database.
 *
 *   set -a && source .env.local && set +a && \
 *     npx tsx scripts/revert-connector.ts --connector messages [--dry-run]
 *
 * Flags:
 *   --connector gmail|messages   Which connector to roll back. Required.
 *   --dry-run                    Show what would happen, change nothing.
 *   --keep-dismissed             Leave "not a person" decisions in place, so a
 *                                re-sync doesn't re-propose everyone you already
 *                                declined. Recommended if you plan to re-sync.
 *
 * What it does, in order:
 *   1. Deletes contacts this connector created (accepted candidates) — this
 *      cascades their changes, interactions and candidate links.
 *   2. Rolls back appended emails/phones on contacts that already existed.
 *   3. Deletes the connector's interactions, candidates and run log.
 *   4. Restores firstInteractionDate/lastInteractionDate/interactionSources
 *      from contact_rollup_baseline, then recomputes the rollup from whatever
 *      interactions remain. The rollup only ever widens, so those three columns
 *      can't be recomputed backwards — the baseline snapshot is what makes this
 *      an exact revert rather than an approximate one. Reverting one connector
 *      while the other stays connected is safe: step 4 re-derives the survivor's
 *      contribution from its own interaction rows.
 *
 * FULL TEARDOWN of both connectors:
 *   1. Run this for each connector.
 *   2. In Postgres:
 *        DROP TABLE interactions;
 *        DROP TABLE contact_candidates;
 *        DROP TABLE contact_rollup_baseline;
 *        DROP TABLE sync_runs;
 *   3. rm -rf ~/.mesh-replica
 *   4. Revoke the app at myaccount.google.com/permissions.
 * All schema changes were additive, so this restores the exact prior state.
 */
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  contactCandidates,
  contactChanges,
  contactRollupBaseline,
  contacts,
  interactions,
  syncRuns,
} from "../src/db/schema";
import { rollupInteractions } from "../src/lib/interactions";

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const keepDismissed = args.includes("--keep-dismissed");
  const connector = args[args.indexOf("--connector") + 1];

  if (connector !== "gmail" && connector !== "messages") {
    console.error("Usage: tsx scripts/revert-connector.ts --connector gmail|messages [--dry-run]");
    process.exit(1);
  }
  const source = connector === "gmail" ? "email" : "messages";

  const db = getDb();
  const log = (msg: string) => console.log(`${dryRun ? "[dry-run] " : ""}${msg}`);

  // 1. Contacts this connector created — accepted candidates only. Deleting
  //    cascades their contact_changes and interactions rows.
  const created = await db
    .select({ id: contacts.id, fullName: contacts.fullName })
    .from(contacts)
    .where(eq(contacts.source, connector));
  log(`Deleting ${created.length} contacts created from ${connector}`);
  for (const c of created.slice(0, 20)) log(`  - ${c.fullName}`);
  if (created.length > 20) log(`  … and ${created.length - 20} more`);
  if (!dryRun && created.length) {
    await db.delete(contacts).where(
      inArray(
        contacts.id,
        created.map((c) => c.id),
      ),
    );
  }

  // 2. Emails/phones appended to contacts that already existed. oldValue holds
  //    the array as it was, so this restores it exactly.
  const appended = await db
    .select()
    .from(contactChanges)
    .where(eq(contactChanges.source, connector));
  log(`Rolling back ${appended.length} appended email/phone changes`);
  if (!dryRun) {
    for (const ch of appended) {
      const restored = (ch.oldValue ?? "")
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);
      await db
        .update(contacts)
        .set({ [ch.field]: restored, updatedAt: new Date() })
        .where(eq(contacts.id, ch.contactId));
    }
    await db.delete(contactChanges).where(eq(contactChanges.source, connector));
  }

  // 3. The connector's own rows.
  const [interactionCount] = await db
    .select({ n: count() })
    .from(interactions)
    .where(eq(interactions.source, source));
  log(`Deleting ${interactionCount?.n ?? 0} ${source} interaction rows`);

  const candidateFilter = keepDismissed
    ? and(
        eq(contactCandidates.source, connector),
        inArray(contactCandidates.status, ["pending", "accepted"]),
      )
    : eq(contactCandidates.source, connector);
  const candidateRows = await db.select().from(contactCandidates).where(candidateFilter);
  log(
    `Deleting ${candidateRows.length} candidates` +
      (keepDismissed ? " (keeping dismissals)" : ""),
  );

  const [baseline] = await db.select({ n: count() }).from(contactRollupBaseline);
  log(`Restoring interaction dates on ${baseline?.n ?? 0} contacts from baseline`);

  if (!dryRun) {
    await db.delete(interactions).where(eq(interactions.source, source));
    await db.delete(contactCandidates).where(candidateFilter);
    await db.delete(syncRuns).where(eq(syncRuns.connector, connector));

    // Rewind the three rollup columns to their pre-connector values, then let
    // the rollup re-apply whatever interactions are left. Clearing the baseline
    // afterwards means the next rollup re-snapshots the now-correct original.
    await db.execute(sql`
      update contacts c set
        first_interaction_date = b.first_interaction_date,
        last_interaction_date  = b.last_interaction_date,
        interaction_sources    = b.interaction_sources,
        updated_at = now()
      from contact_rollup_baseline b
      where c.id = b.contact_id
    `);
    await db.delete(contactRollupBaseline);

    const rolled = await rollupInteractions();
    log(`Recomputed rollup — ${rolled} contacts re-widened from remaining sources`);
  }

  log("Done.");
  if (dryRun) console.log("\nDry run — nothing was written.");
}

main();
