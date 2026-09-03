/**
 * Folds the Apple address book into Rontext. Mac-only, so it lives in scripts/
 * beside its reader rather than under src/lib/jobs — same rule
 * scripts/messages-reader.ts follows, and it keeps node:child_process out of
 * anything Next compiles.
 *
 * Matching, merging and creation are all applyParsedPeople() — the same
 * email → phone(last-10) → normalized-name fold the vCard and Google Contacts
 * paths use. Nothing new decides who is who.
 *
 * THE CURSOR, and why creation is gated on ZCREATIONDATE and not on it:
 * the cursor is max(creation, modification), so an edit brings a person back
 * for another pass. But iCloud rewrites ZMODIFICATIONDATE on *every* contact
 * during a re-sync (this book has 300+ rows sharing one such timestamp), and
 * if creation keyed off that, one re-sync would import the entire address book
 * the baseline was meant to keep out. So each pass splits what it reads:
 *
 *   created since the cursor  → createMissing: true   (the new person)
 *   merely touched            → createMissing: false  (fill gaps only)
 *
 * A bulk touch can then only ever fill in a missing number on somebody already
 * in the book, which is exactly what it should do.
 *
 * Standalone run (the agent supplies its own env):
 *   set -a && source .env.local && set +a && npx tsx scripts/apple-contacts-sync.ts
 */
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { appState } from "../src/db/schema";
import { applyParsedPeople, type ContactsImportSummary } from "../src/lib/contacts-import-core";
import {
  readAppleContacts,
  latestTouchedAt,
  type AppleContact,
} from "./apple-contacts-reader";

// Re-exported so a caller (the Mac agent) needs only this module to both run
// the pass and explain a permissions failure.
export { isFullDiskAccessError, FULL_DISK_ACCESS_HINT } from "./apple-contacts-reader";

/** Apple-epoch seconds of the newest record the last successful run saw. */
const CURSOR_KEY = "apple_contacts_cursor";

/** "Known from: …" on the About tab, and the interactionSources tag. */
const SOURCE_TAG = "apple-contacts";

export type AppleContactsSummary = {
  baseline: boolean;
  /** Address-book records the cursor let through, before matching. */
  scanned: number;
  created: number;
  phonesAdded: number;
  emailsAdded: number;
  birthdaysAdded: number;
  fieldsFilled: number;
  cursor: number;
};

async function readCursor(): Promise<number | null> {
  const [row] = await getDb()
    .select({ value: appState.value })
    .from(appState)
    .where(eq(appState.key, CURSOR_KEY));
  const n = row ? Number(row.value) : NaN;
  return Number.isFinite(n) ? n : null;
}

async function writeCursor(value: number): Promise<void> {
  const now = new Date();
  await getDb()
    .insert(appState)
    .values({ key: CURSOR_KEY, value: String(value), updatedAt: now })
    .onConflictDoUpdate({
      target: appState.key,
      set: { value: String(value), updatedAt: now },
    });
}

type Totals = Pick<
  ContactsImportSummary,
  "created" | "phonesAdded" | "emailsAdded" | "birthdaysAdded" | "fieldsFilled"
>;

const ZERO: Totals = {
  created: 0,
  phonesAdded: 0,
  emailsAdded: 0,
  birthdaysAdded: 0,
  fieldsFilled: 0,
};

const add = (a: Totals, b: ContactsImportSummary): Totals => ({
  created: a.created + b.created,
  phonesAdded: a.phonesAdded + b.phonesAdded,
  emailsAdded: a.emailsAdded + b.emailsAdded,
  birthdaysAdded: a.birthdaysAdded + b.birthdaysAdded,
  fieldsFilled: a.fieldsFilled + b.fieldsFilled,
});

/** One human line for job_runs.message and the Automation panel. */
export function describe(s: AppleContactsSummary): string {
  if (s.baseline) {
    return `baseline set — ${s.scanned} contacts on file, 0 created`;
  }
  const parts = [
    s.created ? `${s.created} added` : null,
    s.phonesAdded ? `${s.phonesAdded} phone${s.phonesAdded === 1 ? "" : "s"}` : null,
    s.emailsAdded ? `${s.emailsAdded} email${s.emailsAdded === 1 ? "" : "s"}` : null,
    s.birthdaysAdded ? `${s.birthdaysAdded} birthday${s.birthdaysAdded === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : `nothing new (${s.scanned} scanned)`;
}

/**
 * Read what changed since the cursor and fold it in. The cursor advances only
 * on the way out, so a failed pass is retried rather than skipped.
 */
export async function syncAppleContacts(opts: {
  dryRun?: boolean;
  /** Ignore the stored cursor and re-baseline from scratch. */
  reset?: boolean;
  log?: (line: string) => void;
} = {}): Promise<AppleContactsSummary> {
  const log = opts.log ?? (() => {});
  const cursor = opts.reset ? null : await readCursor();

  // First ever run (or --reset): remember where the book stands and create
  // nothing. Importing 570 existing contacts — old SIM entries, delivery
  // drivers, one-off codes — is not what "add my new contacts" means.
  if (cursor === null) {
    const all = readAppleContacts(null);
    const at = latestTouchedAt();
    log(`baseline: ${all.length} contacts on file, nothing imported`);
    if (!opts.dryRun) await writeCursor(at);
    return {
      baseline: true,
      scanned: all.length,
      created: 0,
      phonesAdded: 0,
      emailsAdded: 0,
      birthdaysAdded: 0,
      fieldsFilled: 0,
      cursor: at,
    };
  }

  const changed = readAppleContacts(cursor);
  const isNew = (c: AppleContact) => (c.createdAt ?? 0) > cursor;
  const fresh = changed.filter(isNew).map((c) => c.person);
  const touched = changed.filter((c) => !isNew(c)).map((c) => c.person);
  log(`${changed.length} touched since cursor — ${fresh.length} new, ${touched.length} edited`);

  let totals: Totals = { ...ZERO };
  if (!opts.dryRun) {
    if (fresh.length) {
      const s = await applyParsedPeople(fresh, {
        createMissing: true,
        sourceTag: SOURCE_TAG,
        contactSource: "contacts",
        logAdditions: true,
      });
      totals = add(totals, s);
    }
    if (touched.length) {
      const s = await applyParsedPeople(touched, {
        createMissing: false,
        sourceTag: SOURCE_TAG,
        logAdditions: true,
      });
      totals = add(totals, s);
    }
  }

  const at = changed.reduce((m, c) => Math.max(m, c.touchedAt), cursor);
  if (!opts.dryRun) await writeCursor(at);

  return { baseline: false, scanned: changed.length, ...totals, cursor: at };
}

// Run directly for a one-off pass: --dry-run reads and reports without writing,
// --reset re-baselines (useful after a restore, or to stop a bad cursor).
if (process.argv[1]?.endsWith("apple-contacts-sync.ts")) {
  const argv = process.argv.slice(2);
  syncAppleContacts({
    dryRun: argv.includes("--dry-run"),
    reset: argv.includes("--reset"),
    log: console.log,
  })
    .then((s) => {
      console.log(describe(s));
      process.exit(0);
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
