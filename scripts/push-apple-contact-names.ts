/**
 * Push corrected first/last names from Rontext to Apple Contacts, run from web/:
 *
 *   Preview without writing anything:
 *     set -a && source .env.local && set +a && npx tsx scripts/push-apple-contact-names.ts --dry-run
 *
 *   For real:
 *     set -a && source .env.local && set +a && npx tsx scripts/push-apple-contact-names.ts
 *
 *   Undo a previous run (path is printed at the end of a real run):
 *     set -a && source .env.local && set +a && npx tsx scripts/push-apple-contact-names.ts --undo <log-file> --confirm
 *
 * Flags:
 *   --dry-run       List proposed changes, write nothing.
 *   --force         Apply even if the change count is above the safety cap below.
 *   --only P        Restrict to a single phone number P (any format — matched
 *                   on the last 10 digits). Useful for proving a run against
 *                   one contact before trusting it against everyone.
 *   --exclude I,I   Skip these Rontext contact ids (comma-separated), even if
 *                   they'd otherwise match and differ — for a reviewed change
 *                   you want to hold back this run.
 *   --undo P        Restore names from a previous run's log at path P. Only a
 *                   preview without --confirm.
 *   --confirm       Required alongside --undo to actually write the restore.
 *
 * Requires Automation permission for whatever runs this (Terminal, Claude
 * Code) to control Contacts, granted in System Settings → Privacy &
 * Security → Automation. Without it every call fails with "Not authorized to
 * send Apple events to Contacts. (-1743)".
 *
 * Matches an Apple Contacts person to a Rontext contact by phone number (last
 * 10 digits — same convention as src/lib/contacts-import-core.ts) and, where
 * the spelling differs, overwrites the Apple contact's name with Rontext's.
 * That's the opposite policy of contacts-import-core.ts's vCard import, which
 * only ever fills gaps — here Rontext is assumed correct on purpose. This
 * script touches first/last name ONLY: no email, phone, company, notes, or
 * photo, and it never creates a new Apple contact. A phone number that's
 * ambiguous on either side, or that resolves to conflicting names across
 * multiple matches, is skipped rather than guessed.
 *
 * Safety:
 *  - Before any real write (a push OR an undo), the entire local Contacts
 *    data store (~/Library/Application Support/AddressBook) is copied to
 *    ~/.mesh-replica/contacts-backups/<timestamp>/. The run aborts before
 *    writing anything if that backup fails — this is the last-resort path if
 *    something goes wrong beyond what the log below can fix: quit Contacts,
 *    replace the AddressBook folder with the backup, relaunch. That's a local
 *    restore only — it won't retroactively un-sync anything that already
 *    reached iCloud/other devices before you restore.
 *  - Every applied change is appended to
 *    ~/.mesh-replica/contacts-push-log-<timestamp>.json with the prior name,
 *    so a bad run can be undone with --undo <that file> --confirm. This is
 *    the primary, tested undo path — reach for it before the raw backup.
 *  - A real run refuses to apply more than MAX_CHANGES changes unless --force
 *    is passed: an unexpectedly large diff is a sign the matching logic found
 *    something wrong, not a batch of real misspellings.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getDb } from "../src/db";
import { contacts } from "../src/db/schema";

const ADDRESS_BOOK_DIR = join(
  homedir(),
  "Library",
  "Application Support",
  "AddressBook",
);
const STATE_DIR = join(homedir(), ".mesh-replica");
const BACKUPS_DIR = join(STATE_DIR, "contacts-backups");

/**
 * This feature exists to fix a handful of misspellings. A diff this large
 * means the matching logic found something wrong, not that many real
 * corrections are waiting — stop and let a human look rather than rewrite
 * dozens of names.
 */
const MAX_CHANGES = 30;

type ApplePerson = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  phones: string[];
};

type RontextContact = {
  id: number;
  firstName: string | null;
  lastName: string | null;
  phoneNumbers: string[];
};

type NamePair = { firstName: string | null; lastName: string | null };

type Change = {
  appleId: string;
  phone: string;
  contactId: number;
  before: NamePair;
  after: NamePair;
};

type LogFile = { appliedAt: string; changes: Change[] };

const digits = (s: string) => s.replace(/\D/g, "");

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Trimmed, joined display form — also doubles as the equality check below.
 * Comparing the combined name rather than firstName/lastName separately
 * matters for title-style entries ("Coach Hank" / "Stephens" vs "Coach" /
 * "Hank Stephens"): Apple and Rontext can split the exact same name across
 * the field boundary differently with no real spelling difference. Only a
 * change to what the name actually reads as should count as a change.
 */
function nameLabel(n: NamePair): string {
  return (
    [n.firstName, n.lastName]
      .map((s) => s?.trim())
      .filter(Boolean)
      .join(" ") || "(blank)"
  );
}

/** `osascript -l JavaScript`, array args only — never a shell string. */
function runJxa(source: string): string {
  try {
    return execFileSync("osascript", ["-l", "JavaScript", "-e", source], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/-1743|not authorized/i.test(msg)) {
      throw new Error(
        "Not authorized to control Contacts — grant Automation access to " +
          "this terminal/app in System Settings → Privacy & Security → " +
          "Automation, then retry.",
      );
    }
    throw err;
  }
}

function readApplePeople(): ApplePerson[] {
  const out = runJxa(`
    const Contacts = Application("Contacts");
    JSON.stringify(Contacts.people().map(p => ({
      id: p.id(),
      firstName: p.firstName(),
      lastName: p.lastName(),
      phones: p.phones().map(ph => ph.value()),
    })));
  `);
  return out.trim() ? (JSON.parse(out) as ApplePerson[]) : [];
}

function readAppleName(id: string): NamePair {
  const out = runJxa(`
    const Contacts = Application("Contacts");
    const p = Contacts.people.whose({id: ${JSON.stringify(id)}})()[0];
    JSON.stringify({firstName: p.firstName(), lastName: p.lastName()});
  `);
  return JSON.parse(out) as NamePair;
}

function writeAppleName(id: string, name: NamePair): void {
  runJxa(`
    const Contacts = Application("Contacts");
    const p = Contacts.people.whose({id: ${JSON.stringify(id)}})()[0];
    p.firstName = ${JSON.stringify(name.firstName ?? "")};
    p.lastName = ${JSON.stringify(name.lastName ?? "")};
    Contacts.save();
  `);
}

function backupAddressBook(): string {
  if (!existsSync(ADDRESS_BOOK_DIR)) {
    throw new Error(
      `No Contacts data found at ${ADDRESS_BOOK_DIR} — refusing to write without a backup.`,
    );
  }
  const dir = join(BACKUPS_DIR, timestamp());
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  cpSync(ADDRESS_BOOK_DIR, join(dir, "AddressBook"), { recursive: true });
  return dir;
}

function writeSafetyLog(changes: Change[]): string {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const path = join(STATE_DIR, `contacts-push-log-${timestamp()}.json`);
  const payload: LogFile = { appliedAt: new Date().toISOString(), changes };
  writeFileSync(path, JSON.stringify(payload, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600); // explicit — writeFileSync honours umask
  return path;
}

/** A key's second-seen entry replaces the first with the "dup" sentinel. */
function keyByPhone<T>(items: T[], getPhones: (item: T) => string[]): Map<string, T | "dup"> {
  const map = new Map<string, T | "dup">();
  for (const item of items) {
    for (const raw of getPhones(item)) {
      const d = digits(raw);
      if (d.length < 10) continue;
      const key = d.slice(-10);
      map.set(key, map.has(key) ? "dup" : item);
    }
  }
  return map;
}

type Summary = {
  scanned: number;
  matchedByPhone: number;
  ambiguousApple: number;
  ambiguousRontext: number;
  ambiguousConflict: number;
  alreadyCorrect: number;
  changes: number;
};

function computeChanges(
  applePeople: ApplePerson[],
  rontextContacts: RontextContact[],
  opts: { onlyKey?: string; excludeIds?: Set<number> } = {},
): { changes: Change[]; summary: Summary } {
  const matchesOnly = (phones: string[]) =>
    !opts.onlyKey || phones.some((p) => digits(p).slice(-10) === opts.onlyKey);

  const appleScoped = opts.onlyKey ? applePeople.filter((p) => matchesOnly(p.phones)) : applePeople;
  const rontextScoped = (
    opts.onlyKey ? rontextContacts.filter((c) => matchesOnly(c.phoneNumbers)) : rontextContacts
  ).filter((c) => !opts.excludeIds?.has(c.id));

  const appleByPhone = keyByPhone(appleScoped, (p) => p.phones);
  const rontextCandidates = rontextScoped.filter((c) =>
    c.phoneNumbers.some((p) => digits(p).length >= 10),
  );
  const rontextByPhone = keyByPhone(rontextCandidates, (c) => c.phoneNumbers);

  const ambiguousApple = [...appleByPhone.values()].filter((v) => v === "dup").length;
  const ambiguousRontext = [...rontextByPhone.values()].filter((v) => v === "dup").length;

  let matchedByPhone = 0;
  let alreadyCorrect = 0;
  const rawChanges: Change[] = [];

  for (const [key, rontextEntry] of rontextByPhone) {
    if (rontextEntry === "dup") continue;
    const appleEntry = appleByPhone.get(key);
    if (!appleEntry || appleEntry === "dup") continue;
    matchedByPhone++;

    const wantFirst = rontextEntry.firstName?.trim() || null;
    const wantLast = rontextEntry.lastName?.trim() || null;
    if (!wantFirst && !wantLast) continue; // nothing in Rontext to push

    const before: NamePair = { firstName: appleEntry.firstName, lastName: appleEntry.lastName };
    const after: NamePair = {
      firstName: wantFirst ?? appleEntry.firstName,
      lastName: wantLast ?? appleEntry.lastName,
    };
    if (nameLabel(before) === nameLabel(after)) {
      alreadyCorrect++;
      continue;
    }

    rawChanges.push({
      appleId: appleEntry.id,
      phone: key,
      contactId: rontextEntry.id,
      before,
      after,
    });
  }

  // A phone number is only supposed to reach one Apple contact via one
  // Rontext contact. If the same Apple id ends up with two different
  // proposed names (e.g. two of the Rontext contact's phone numbers each
  // matched a different Apple person's shared number), that's a sign of a
  // collision, not two agreeing corrections — drop all of them.
  const byAppleId = new Map<string, Change[]>();
  for (const c of rawChanges) {
    const arr = byAppleId.get(c.appleId) ?? [];
    arr.push(c);
    byAppleId.set(c.appleId, arr);
  }
  let ambiguousConflict = 0;
  const changes: Change[] = [];
  for (const arr of byAppleId.values()) {
    const distinct = new Set(arr.map((c) => `${c.after.firstName}|${c.after.lastName}`));
    if (distinct.size > 1) {
      ambiguousConflict += arr.length;
      continue;
    }
    changes.push(arr[0]);
  }

  return {
    changes,
    summary: {
      scanned: rontextCandidates.length,
      matchedByPhone,
      ambiguousApple,
      ambiguousRontext,
      ambiguousConflict,
      alreadyCorrect,
      changes: changes.length,
    },
  };
}

async function runPush(
  dryRun: boolean,
  force: boolean,
  onlyKey?: string,
  excludeIds?: Set<number>,
): Promise<void> {
  const applePeople = readApplePeople();
  const rontextRows: RontextContact[] = await getDb()
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      phoneNumbers: contacts.phoneNumbers,
    })
    .from(contacts);

  console.log(
    `Read ${applePeople.length} Apple contacts and ${rontextRows.length} Rontext contacts.` +
      (onlyKey ? ` Restricted to phone …${onlyKey.slice(-4)}.` : "") +
      (excludeIds?.size ? ` Excluding contact id(s) ${[...excludeIds].join(", ")}.` : ""),
  );

  const { changes, summary } = computeChanges(applePeople, rontextRows, { onlyKey, excludeIds });
  console.log(JSON.stringify(summary, null, 2));

  if (changes.length) {
    console.log(`\n${dryRun ? "Would change" : "Changed"}:`);
    for (const c of changes.slice(0, 40)) {
      console.log(
        `  "${nameLabel(c.before)}" → "${nameLabel(c.after)}" (phone …${c.phone.slice(-4)})`,
      );
    }
    if (changes.length > 40) console.log(`  … and ${changes.length - 40} more`);
  }

  if (dryRun) {
    console.log("\nDry run — nothing was written, no backup or log created.");
    return;
  }
  if (!changes.length) {
    console.log("\nNothing to change.");
    return;
  }
  if (changes.length > MAX_CHANGES && !force) {
    console.error(
      `\nRefusing to apply ${changes.length} changes — that's above the safety cap of ` +
        `${MAX_CHANGES}. Re-run with --force if this is really expected.`,
    );
    process.exit(1);
  }

  const backupDir = backupAddressBook();
  console.log(`\nBacked up Contacts to ${backupDir} before writing.`);

  for (const c of changes) writeAppleName(c.appleId, c.after);

  const logPath = writeSafetyLog(changes);
  console.log(`Applied ${changes.length} change(s).`);
  console.log(`Undo with:`);
  console.log(
    `  set -a && source .env.local && set +a && npx tsx scripts/push-apple-contact-names.ts --undo ${logPath} --confirm`,
  );
}

async function runUndo(logPath: string, confirm: boolean): Promise<void> {
  if (!existsSync(logPath)) {
    console.error(`No such log file: ${logPath}`);
    process.exit(1);
  }
  const log = JSON.parse(readFileSync(logPath, "utf8")) as LogFile;
  console.log(`Log from ${log.appliedAt} — ${log.changes.length} change(s) recorded.`);

  // Only restore a name that still matches what this log expects — if it's
  // moved on since, blindly restoring could clobber a newer, unrelated edit.
  const toRestore: Change[] = [];
  const skipped: Change[] = [];
  for (const c of log.changes) {
    const current = readAppleName(c.appleId);
    const stillMatches =
      (current.firstName ?? "") === (c.after.firstName ?? "") &&
      (current.lastName ?? "") === (c.after.lastName ?? "");
    (stillMatches ? toRestore : skipped).push(c);
  }

  console.log(`\nWould restore ${toRestore.length} contact(s):`);
  for (const c of toRestore.slice(0, 40)) {
    console.log(`  "${nameLabel(c.after)}" → "${nameLabel(c.before)}"`);
  }
  if (skipped.length) {
    console.log(
      `\n${skipped.length} skipped — the current name no longer matches what this log ` +
        `recorded, so restoring could overwrite a newer edit:`,
    );
    for (const c of skipped.slice(0, 20)) {
      console.log(`  contact id ${c.contactId} / apple id ${c.appleId}`);
    }
  }

  if (!confirm) {
    console.log("\nDry run — pass --confirm to actually restore these names.");
    return;
  }
  if (!toRestore.length) {
    console.log("\nNothing to restore.");
    return;
  }

  const backupDir = backupAddressBook();
  console.log(`\nBacked up Contacts to ${backupDir} before writing.`);

  for (const c of toRestore) writeAppleName(c.appleId, c.before);

  const newLogPath = writeSafetyLog(
    toRestore.map((c) => ({ ...c, before: c.after, after: c.before })),
  );
  console.log(`Restored ${toRestore.length} name(s). Recorded as ${newLogPath}.`);
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const force = argv.includes("--force");
  const confirm = argv.includes("--confirm");
  const undoIdx = argv.indexOf("--undo");
  const undoPath = undoIdx >= 0 ? argv[undoIdx + 1] : null;
  const onlyIdx = argv.indexOf("--only");
  const onlyRaw = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;
  const onlyKey = onlyRaw ? digits(onlyRaw).slice(-10) : undefined;
  const excludeIdx = argv.indexOf("--exclude");
  const excludeRaw = excludeIdx >= 0 ? argv[excludeIdx + 1] : null;
  const excludeIds = excludeRaw
    ? new Set(excludeRaw.split(",").map((s) => Number(s.trim())))
    : undefined;

  try {
    if (undoPath) {
      await runUndo(undoPath, confirm);
    } else {
      await runPush(dryRun, force, onlyKey, excludeIds);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
