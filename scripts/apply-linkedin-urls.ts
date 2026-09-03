/**
 * Fill contacts.linkedin_url from a found-URLs JSON written by the classbook
 * LinkedIn search (Claude driving the owner's logged-in Chrome).
 *
 *   set -a && source .env.local && set +a && \
 *     npx tsx scripts/apply-linkedin-urls.ts <found.json> [--dry-run]
 *
 * Input: { "<contactId>": ["<name>", "<linkedinUrl>"], ... }
 * Fill-gaps only — a contact that already has a linkedin_url is skipped, and
 * a URL already claimed by another contact is reported, never reassigned.
 * Each fill logs a contact_changes row (source "import"). Idempotent.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contactChanges, contacts } from "../src/db/schema";
import { normalizeLinkedin } from "../src/lib/contact-merge";

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set — source .env.local first.");
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const path = args.find((a) => !a.startsWith("--"));
  if (!path) {
    console.error("Usage: apply-linkedin-urls.ts <found.json> [--dry-run]");
    process.exit(1);
  }
  const found = JSON.parse(readFileSync(resolve(path), "utf8")) as Record<
    string,
    [string, string]
  >;

  const db = getDb();
  const all = await db
    .select({ id: contacts.id, fullName: contacts.fullName, linkedinUrl: contacts.linkedinUrl })
    .from(contacts);
  const byId = new Map(all.map((c) => [c.id, c]));
  const byUrl = new Map(all.filter((c) => c.linkedinUrl).map((c) => [c.linkedinUrl!, c]));

  let filled = 0;
  const skippedHasUrl: string[] = [];
  const conflicts: string[] = [];
  const notFound: string[] = [];

  for (const [idStr, [name, rawUrl]] of Object.entries(found)) {
    const id = Number(idStr);
    const url = normalizeLinkedin(rawUrl);
    if (!url) {
      notFound.push(`${id} ${name} (unparseable url: ${rawUrl})`);
      continue;
    }
    const contact = byId.get(id);
    if (!contact) {
      notFound.push(`${id} ${name}`);
      continue;
    }
    if (contact.linkedinUrl) {
      skippedHasUrl.push(contact.fullName);
      continue;
    }
    const owner = byUrl.get(url);
    if (owner && owner.id !== id) {
      conflicts.push(`${url} already on #${owner.id} ${owner.fullName} (wanted for ${name})`);
      continue;
    }
    if (!dryRun) {
      await db
        .update(contacts)
        .set({ linkedinUrl: url, updatedAt: new Date() })
        .where(eq(contacts.id, id));
      await db.insert(contactChanges).values({
        contactId: id,
        field: "linkedinUrl",
        oldValue: null,
        newValue: url,
        source: "import",
      });
    }
    byUrl.set(url, { id, fullName: contact.fullName, linkedinUrl: url });
    filled++;
  }

  console.log(
    JSON.stringify({ dryRun, total: Object.keys(found).length, filled, skippedHasUrl, conflicts, notFound }, null, 2),
  );
  if (conflicts.length || notFound.length) process.exit(1);
}

main();
