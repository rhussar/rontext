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
 *   --create        Also CREATE an Apple contact for each scoped Rontext
 *                   contact that has a usable phone number but no Apple match.
 *                   Off by default: without it this script only ever renames.
 *   --group NAME    Restrict to members of a Rontext group (exact name, e.g.
 *                   "Silver Scholar"). Applies to renames and creations alike.
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
 * photo. A phone number that's ambiguous on either side, or that resolves to
 * conflicting names across multiple matches, is skipped rather than guessed.
 *
 * With --create it will additionally create Apple contacts that don't exist
 * yet, which is the one case where it writes a field other than a name: a
 * created contact gets its name AND its phone numbers, because a contact
 * created without a phone would be unmatchable by every connector in this
 * repo (including this script's own rename pass) forever after. It still
 * writes no email, company, notes, or photo. Creation only ever ADDS a
 * person — it never merges into, edits, or deletes an existing Apple contact,
 * and it skips anyone whose number already reaches one.
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
 *  - Creations are recorded in the same log as renames, so --undo reverses
 *    them by deleting the contacts this script created — and only those,
 *    only while they still look exactly as created (see runUndo).
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
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contactGroups, contacts, groups } from "../src/db/schema";

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
  archivedAt: Date | null;
};

type NamePair = { firstName: string | null; lastName: string | null };

type Change = {
  appleId: string;
  phone: string;
  contactId: number;
  before: NamePair;
  after: NamePair;
};

/**
 * A contact this run added to Apple Contacts. `phones` is what we wrote, and
 * --undo compares against it before deleting: an entry that has since grown a
 * phone number, or lost one, is no longer purely ours to remove.
 */
type Creation = {
  appleId: string;
  contactId: number;
  name: NamePair;
  phones: string[];
};

type LogFile = { appliedAt: string; changes: Change[]; creations?: Creation[] };

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

/**
 * Creates a person with name + phones and returns the new Apple id. Phones are
 * added after the person is pushed (a Person built with a phones array in the
 * initialiser silently drops them), and everything is saved once at the end.
 */
function createAppleContact(name: NamePair, phones: string[]): string {
  const out = runJxa(`
    const Contacts = Application("Contacts");
    const p = Contacts.Person({
      firstName: ${JSON.stringify(name.firstName ?? "")},
      lastName: ${JSON.stringify(name.lastName ?? "")},
    });
    Contacts.people.push(p);
    for (const value of ${JSON.stringify(phones)}) {
      p.phones.push(Contacts.Phone({label: "mobile", value: value}));
    }
    Contacts.save();
    p.id();
  `);
  const id = out.trim();
  if (!id)
    throw new Error(
      `Contacts returned no id when creating "${nameLabel(name)}".`,
    );
  return id;
}

/**
 * Everything --undo needs to decide whether a created contact is still
 * untouched. Returns null if the id is gone (already deleted by hand).
 */
function readAppleSnapshot(
  id: string,
): { name: NamePair; phones: string[]; extras: boolean } | null {
  const out = runJxa(`
    const Contacts = Application("Contacts");
    const matches = Contacts.people.whose({id: ${JSON.stringify(id)}})();
    if (!matches.length) { "null" } else {
      const p = matches[0];
      JSON.stringify({
        name: {firstName: p.firstName(), lastName: p.lastName()},
        phones: p.phones().map(ph => ph.value()),
        extras: p.emails().length > 0 || p.addresses().length > 0 ||
                !!p.organization() || !!p.note(),
      });
    }
  `);
  const trimmed = out.trim();
  if (!trimmed || trimmed === "null") return null;
  return JSON.parse(trimmed);
}

function deleteAppleContact(id: string): void {
  runJxa(`
    const Contacts = Application("Contacts");
    const matches = Contacts.people.whose({id: ${JSON.stringify(id)}})();
    if (matches.length) { Contacts.delete(matches[0]); Contacts.save(); }
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

function newLogPath(): string {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  return join(STATE_DIR, `contacts-push-log-${timestamp()}.json`);
}

/** Rewrites `path` in full — safe to call repeatedly as a run progresses. */
function writeSafetyLog(
  path: string,
  changes: Change[],
  creations: Creation[] = [],
): void {
  const payload: LogFile = {
    appliedAt: new Date().toISOString(),
    changes,
    creations,
  };
  writeFileSync(path, JSON.stringify(payload, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600); // explicit — writeFileSync honours umask
}

/** A key's second-seen entry replaces the first with the "dup" sentinel. */
function keyByPhone<T>(
  items: T[],
  getPhones: (item: T) => string[],
): Map<string, T | "dup"> {
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

  const appleScoped = opts.onlyKey
    ? applePeople.filter((p) => matchesOnly(p.phones))
    : applePeople;
  const rontextScoped = (
    opts.onlyKey
      ? rontextContacts.filter((c) => matchesOnly(c.phoneNumbers))
      : rontextContacts
  ).filter((c) => !opts.excludeIds?.has(c.id));

  const appleByPhone = keyByPhone(appleScoped, (p) => p.phones);
  const rontextCandidates = rontextScoped.filter((c) =>
    c.phoneNumbers.some((p) => digits(p).length >= 10),
  );
  const rontextByPhone = keyByPhone(rontextCandidates, (c) => c.phoneNumbers);

  const ambiguousApple = [...appleByPhone.values()].filter(
    (v) => v === "dup",
  ).length;
  const ambiguousRontext = [...rontextByPhone.values()].filter(
    (v) => v === "dup",
  ).length;

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

    const before: NamePair = {
      firstName: appleEntry.firstName,
      lastName: appleEntry.lastName,
    };
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
    const distinct = new Set(
      arr.map((c) => `${c.after.firstName}|${c.after.lastName}`),
    );
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

/** Every Rontext contact, or just one group's members when --group is given. */
async function loadRontextContacts(
  groupName?: string,
): Promise<RontextContact[]> {
  const db = getDb();
  const cols = {
    id: contacts.id,
    firstName: contacts.firstName,
    lastName: contacts.lastName,
    phoneNumbers: contacts.phoneNumbers,
    archivedAt: contacts.archivedAt,
  };
  if (!groupName) return db.select(cols).from(contacts);

  const [group] = await db
    .select({ id: groups.id })
    .from(groups)
    .where(eq(groups.name, groupName));
  if (!group) {
    const all = await db.select({ name: groups.name }).from(groups);
    throw new Error(
      `No Rontext group named "${groupName}". Groups: ` +
        (all.map((g) => `"${g.name}"`).join(", ") || "(none)"),
    );
  }
  return db
    .select(cols)
    .from(contacts)
    .innerJoin(contactGroups, eq(contactGroups.contactId, contacts.id))
    .where(eq(contactGroups.groupId, group.id));
}

type CreationSummary = {
  scanned: number;
  skippedArchived: number;
  skippedNoName: number;
  skippedNoUsablePhone: number;
  alreadyInApple: number;
  ambiguousWithinBatch: number;
  creations: number;
};

/**
 * Plans one new Apple contact per scoped Rontext contact whose phone number
 * reaches nobody in Apple Contacts. Deliberately conservative: anything even
 * slightly unclear is skipped and counted rather than guessed, because a bad
 * creation is a stranger in the user's address book that no later run knows
 * to clean up.
 */
function computeCreations(
  applePeople: ApplePerson[],
  rontextContacts: RontextContact[],
  opts: { onlyKey?: string; excludeIds?: Set<number> } = {},
): { creations: Omit<Creation, "appleId">[]; summary: CreationSummary } {
  const usablePhones = (phones: string[]) =>
    phones.filter((p) => digits(p).length >= 10);
  const keysOf = (phones: string[]) =>
    usablePhones(phones).map((p) => digits(p).slice(-10));

  const scoped = rontextContacts
    .filter(
      (c) => !opts.onlyKey || keysOf(c.phoneNumbers).includes(opts.onlyKey),
    )
    .filter((c) => !opts.excludeIds?.has(c.id));

  const appleKeys = new Set(applePeople.flatMap((p) => keysOf(p.phones)));

  // Two Rontext contacts sharing a number can't both be created — we'd be
  // guessing which person that number belongs to. Skip the whole key.
  const keyCounts = new Map<string, number>();
  for (const c of scoped) {
    for (const k of new Set(keysOf(c.phoneNumbers))) {
      keyCounts.set(k, (keyCounts.get(k) ?? 0) + 1);
    }
  }

  const summary: CreationSummary = {
    scanned: scoped.length,
    skippedArchived: 0,
    skippedNoName: 0,
    skippedNoUsablePhone: 0,
    alreadyInApple: 0,
    ambiguousWithinBatch: 0,
    creations: 0,
  };
  const creations: Omit<Creation, "appleId">[] = [];

  for (const c of scoped) {
    if (c.archivedAt) {
      summary.skippedArchived++;
      continue;
    }
    const firstName = c.firstName?.trim() || null;
    const lastName = c.lastName?.trim() || null;
    if (!firstName && !lastName) {
      summary.skippedNoName++;
      continue;
    }
    const phones = usablePhones(c.phoneNumbers);
    if (!phones.length) {
      summary.skippedNoUsablePhone++;
      continue;
    }
    const keys = keysOf(c.phoneNumbers);
    if (keys.some((k) => appleKeys.has(k))) {
      summary.alreadyInApple++;
      continue;
    }
    if (keys.some((k) => (keyCounts.get(k) ?? 0) > 1)) {
      summary.ambiguousWithinBatch++;
      continue;
    }
    creations.push({ contactId: c.id, name: { firstName, lastName }, phones });
  }

  summary.creations = creations.length;
  return { creations, summary };
}

async function runPush(
  dryRun: boolean,
  force: boolean,
  opts: {
    onlyKey?: string;
    excludeIds?: Set<number>;
    groupName?: string;
    create?: boolean;
  } = {},
): Promise<void> {
  const { onlyKey, excludeIds, groupName, create } = opts;
  const applePeople = readApplePeople();
  const rontextRows = await loadRontextContacts(groupName);

  console.log(
    `Read ${applePeople.length} Apple contacts and ${rontextRows.length} Rontext contacts` +
      (groupName ? ` in group "${groupName}"` : "") +
      "." +
      (onlyKey ? ` Restricted to phone …${onlyKey.slice(-4)}.` : "") +
      (excludeIds?.size
        ? ` Excluding contact id(s) ${[...excludeIds].join(", ")}.`
        : ""),
  );

  const { changes, summary } = computeChanges(applePeople, rontextRows, {
    onlyKey,
    excludeIds,
  });
  console.log("Renames:");
  console.log(JSON.stringify(summary, null, 2));

  const planned = create
    ? computeCreations(applePeople, rontextRows, { onlyKey, excludeIds })
    : { creations: [], summary: null };
  if (planned.summary) {
    console.log("Creations:");
    console.log(JSON.stringify(planned.summary, null, 2));
  }

  if (changes.length) {
    console.log(`\n${dryRun ? "Would change" : "Changed"}:`);
    for (const c of changes.slice(0, 40)) {
      console.log(
        `  "${nameLabel(c.before)}" → "${nameLabel(c.after)}" (phone …${c.phone.slice(-4)})`,
      );
    }
    if (changes.length > 40) console.log(`  … and ${changes.length - 40} more`);
  }

  if (planned.creations.length) {
    console.log(`\n${dryRun ? "Would create" : "Created"}:`);
    for (const c of planned.creations.slice(0, 40)) {
      console.log(`  "${nameLabel(c.name)}" (${c.phones.join(", ")})`);
    }
    if (planned.creations.length > 40) {
      console.log(`  … and ${planned.creations.length - 40} more`);
    }
  }

  if (dryRun) {
    console.log("\nDry run — nothing was written, no backup or log created.");
    return;
  }
  const total = changes.length + planned.creations.length;
  if (!total) {
    console.log("\nNothing to change.");
    return;
  }
  if (total > MAX_CHANGES && !force) {
    console.error(
      `\nRefusing to apply ${total} change(s) — that's above the safety cap of ` +
        `${MAX_CHANGES}. Re-run with --force if this is really expected.`,
    );
    process.exit(1);
  }

  const backupDir = backupAddressBook();
  console.log(`\nBacked up Contacts to ${backupDir} before writing.`);

  const logPath = newLogPath();
  for (const c of changes) writeAppleName(c.appleId, c.after);
  writeSafetyLog(logPath, changes);

  const creations: Creation[] = [];
  for (const c of planned.creations) {
    // Re-log after each creation: if a later one throws, --undo on this log
    // still reverses everything already written.
    const appleId = createAppleContact(c.name, c.phones);
    creations.push({ ...c, appleId });
    writeSafetyLog(logPath, changes, creations);
  }
  console.log(
    `Applied ${changes.length} rename(s) and ${creations.length} creation(s).`,
  );
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
  const loggedCreations = log.creations ?? [];
  console.log(
    `Log from ${log.appliedAt} — ${log.changes.length} rename(s) and ` +
      `${loggedCreations.length} creation(s) recorded.`,
  );

  // Undoing a creation means deleting a contact, so the bar is higher than for
  // a rename: only a contact that still looks exactly as this script created
  // it — same name, same phone set, nothing else filled in — is ours to
  // remove. Anything edited since is now partly the user's, and gets left
  // alone for them to delete by hand if they still want it gone.
  const toDelete: Creation[] = [];
  const keptCreations: { creation: Creation; why: string }[] = [];
  for (const c of loggedCreations) {
    const snap = readAppleSnapshot(c.appleId);
    if (!snap) continue; // already gone — nothing to undo
    const sameName = nameLabel(snap.name) === nameLabel(c.name);
    const samePhones =
      snap.phones.length === c.phones.length &&
      [...snap.phones].sort().join("|") === [...c.phones].sort().join("|");
    if (!sameName) keptCreations.push({ creation: c, why: "renamed since" });
    else if (!samePhones)
      keptCreations.push({ creation: c, why: "phone numbers edited since" });
    else if (snap.extras)
      keptCreations.push({ creation: c, why: "other fields filled in since" });
    else toDelete.push(c);
  }

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

  if (toDelete.length) {
    console.log(
      `\nWould DELETE ${toDelete.length} contact(s) this run created:`,
    );
    for (const c of toDelete.slice(0, 40)) {
      console.log(`  "${nameLabel(c.name)}" (${c.phones.join(", ")})`);
    }
    if (toDelete.length > 40)
      console.log(`  … and ${toDelete.length - 40} more`);
  }
  if (keptCreations.length) {
    console.log(
      `\n${keptCreations.length} created contact(s) kept — edited since this run, ` +
        `so no longer purely this script's to delete:`,
    );
    for (const k of keptCreations.slice(0, 20)) {
      console.log(`  "${nameLabel(k.creation.name)}" — ${k.why}`);
    }
  }

  if (!confirm) {
    console.log("\nDry run — pass --confirm to actually apply this undo.");
    return;
  }
  if (!toRestore.length && !toDelete.length) {
    console.log("\nNothing to restore.");
    return;
  }

  const backupDir = backupAddressBook();
  console.log(`\nBacked up Contacts to ${backupDir} before writing.`);

  for (const c of toRestore) writeAppleName(c.appleId, c.before);
  for (const c of toDelete) deleteAppleContact(c.appleId);

  const restoreLog = newLogPath();
  writeSafetyLog(
    restoreLog,
    toRestore.map((c) => ({ ...c, before: c.after, after: c.before })),
  );
  console.log(
    `Restored ${toRestore.length} name(s), deleted ${toDelete.length} created contact(s). ` +
      `Recorded as ${restoreLog}.`,
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const force = argv.includes("--force");
  const create = argv.includes("--create");
  const groupIdx = argv.indexOf("--group");
  const groupName = groupIdx >= 0 ? argv[groupIdx + 1] : undefined;
  if (groupIdx >= 0 && (!groupName || groupName.startsWith("--"))) {
    // Silently falling through to "every contact" here would be the worst
    // possible reading of a typo'd --group.
    console.error('--group needs a group name, e.g. --group "Silver Scholar".');
    process.exit(1);
  }
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
      await runPush(dryRun, force, { onlyKey, excludeIds, groupName, create });
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
