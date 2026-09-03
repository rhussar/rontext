/**
 * The Apple Contacts reader, used by scripts/mac-agent.ts (the hourly launchd
 * job) and runnable on its own to print what it sees. Mac-only by nature — it
 * reads ~/Library/Application Support/AddressBook through the system sqlite3 —
 * so it lives in scripts/, never under src/, and can never run on Vercel.
 *
 * Why SQLite and not JXA: scripts/push-apple-contact-names.ts drives
 * Contacts.app over `osascript`, which needs an *Automation* TCC grant — a
 * prompt nobody can answer from a launchd background job. The address-book
 * files need only Full Disk Access for node, which the Mac agent already has
 * for chat.db. Same copy-then-read shape as scripts/messages-reader.ts.
 *
 * Reads *copies* and never writes to the address book. The push script stays
 * the only thing here that ever edits Contacts, and it stays manual.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVcardDate, type ParsedPerson } from "../src/lib/vcard";

const SOURCES_DIR = join(
  process.env.HOME ?? "",
  "Library",
  "Application Support",
  "AddressBook",
  "Sources",
);
const DB_NAME = "AddressBook-v22.abcddb";

/** Core Data stores timestamps as seconds since 2001-01-01. */
export const APPLE_EPOCH = 978307200;

/**
 * group_concat needs a separator that can't appear inside a phone number,
 * email or name. ASCII 31 (unit separator) is the one character no address
 * book field will ever contain.
 */
const SEP = String.fromCharCode(31);

export type AppleContact = {
  person: ParsedPerson;
  /** Apple-epoch seconds; null only if Contacts never stamped the row. */
  createdAt: number | null;
  /** max(creation, modification) — what the cursor is measured against. */
  touchedAt: number;
};

type Row = {
  uid: string | null;
  first: string | null;
  last: string | null;
  org: string | null;
  title: string | null;
  birthday: string | null;
  note: string | null;
  created: number | null;
  modified: number | null;
  phones: string | null;
  emails: string | null;
};

/**
 * One row per person, with phones and emails folded in by subquery rather than
 * a join so somebody with three numbers stays a single row.
 *
 * ZABCDRECORD holds groups too, hence the Z_PRIMARYKEY join: without it every
 * group would arrive as a nameless "person".
 */
function query(since: number | null): string {
  const where = since === null
    ? ""
    : `and max(coalesce(r.ZCREATIONDATE, 0), coalesce(r.ZMODIFICATIONDATE, 0)) > ${since}`;
  return `
    select
      r.ZUNIQUEID as uid,
      r.ZFIRSTNAME as first,
      r.ZLASTNAME as last,
      r.ZORGANIZATION as org,
      r.ZJOBTITLE as title,
      date(r.ZBIRTHDAY + ${APPLE_EPOCH}, 'unixepoch') as birthday,
      (select n.ZTEXT from ZABCDNOTE n where n.ZCONTACT = r.Z_PK) as note,
      r.ZCREATIONDATE as created,
      r.ZMODIFICATIONDATE as modified,
      (select group_concat(p.ZFULLNUMBER, char(31))
         from ZABCDPHONENUMBER p where p.ZOWNER = r.Z_PK) as phones,
      (select group_concat(e.ZADDRESS, char(31))
         from ZABCDEMAILADDRESS e where e.ZOWNER = r.Z_PK) as emails
    from ZABCDRECORD r
    join Z_PRIMARYKEY k on k.Z_ENT = r.Z_ENT
    where k.Z_NAME = 'ABCDContact' ${where}
  `;
}

/** Every per-account address book on this Mac (iCloud, On My Mac, Exchange…). */
export function sourceDatabases(): string[] {
  if (!existsSync(SOURCES_DIR)) return [];
  return readdirSync(SOURCES_DIR)
    .map((entry) => join(SOURCES_DIR, entry, DB_NAME))
    .filter((path) => existsSync(path));
}

/**
 * The address book is WAL-mode and locked while Contacts.app is running, so
 * read a copy. The -wal and -shm sidecars must come along or sqlite refuses
 * the file outright ("unable to open database file"), and without them a
 * contact added minutes ago wouldn't be in the checkpointed pages yet.
 */
function readSource(dbPath: string, since: number | null): Row[] {
  const dir = mkdtempSync(join(tmpdir(), "rontext-contacts-"));
  try {
    const copy = join(dir, DB_NAME);
    copyFileSync(dbPath, copy);
    for (const ext of ["-wal", "-shm"]) {
      if (existsSync(dbPath + ext)) copyFileSync(dbPath + ext, copy + ext);
    }
    // The system sqlite3 CLI rather than a native npm module: this script can
    // never run on Vercel, and adding better-sqlite3 would drag a native build
    // into the deployed package for no reason.
    const out = execFileSync(
      "/usr/bin/sqlite3",
      ["-readonly", "-json", copy, query(since)],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    return out.trim() ? (JSON.parse(out) as Row[]) : [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const list = (raw: string | null): string[] =>
  (raw ?? "")
    .split(SEP)
    .map((v) => v.trim())
    .filter(Boolean);

const clean = (raw: string | null): string | null => {
  const v = raw?.trim();
  return v ? v : null;
};

function toContact(row: Row): AppleContact | null {
  const emails = list(row.emails);
  const phoneNumbers = list(row.phones);
  const first = clean(row.first);
  const last = clean(row.last);
  const company = clean(row.org);
  const fullName = [first, last].filter(Boolean).join(" ") || company || "";

  // A record with no name and no way to reach anyone is a stub Contacts left
  // behind — there'd be nothing to match on and nothing worth creating.
  if (!fullName || (emails.length === 0 && phoneNumbers.length === 0)) return null;

  const person: ParsedPerson = {
    fullName,
    firstName: first,
    lastName: last,
    emails,
    phoneNumbers,
    company,
    title: clean(row.title),
    // sqlite's date() already yields Apple's 1604 placeholder for a birthday
    // saved without a year, which is exactly what parseVcardDate expects.
    birthday: row.birthday ? parseVcardDate(row.birthday) : null,
    location: null,
    note: clean(row.note),
    linkedinUrl: null,
    photo: null,
  };
  return {
    person,
    createdAt: row.created ?? null,
    touchedAt: Math.max(row.created ?? 0, row.modified ?? 0),
  };
}

/**
 * Every person across every source, or only those touched since an Apple-epoch
 * cursor. De-duplicated by ZUNIQUEID because a contact linked across accounts
 * (iCloud + On My Mac) appears once per source.
 */
export function readAppleContacts(since: number | null): AppleContact[] {
  const dbs = sourceDatabases();
  if (dbs.length === 0) {
    throw new Error(`No address book found at ${SOURCES_DIR}`);
  }
  const byUid = new Map<string, AppleContact>();
  const unkeyed: AppleContact[] = [];
  for (const db of dbs) {
    for (const row of readSource(db, since)) {
      const contact = toContact(row);
      if (!contact) continue;
      if (!row.uid) {
        unkeyed.push(contact);
        continue;
      }
      const prior = byUid.get(row.uid);
      // Keep the most recently touched copy: that's the source holding the
      // edit we're here for.
      if (!prior || contact.touchedAt > prior.touchedAt) byUid.set(row.uid, contact);
    }
  }
  return [...byUid.values(), ...unkeyed];
}

/** The newest timestamp in the whole address book — the baseline cursor. */
export function latestTouchedAt(): number {
  let max = 0;
  for (const contact of readAppleContacts(null)) {
    if (contact.touchedAt > max) max = contact.touchedAt;
  }
  return max;
}

/** True when the error is macOS refusing to open the address book — i.e. no Full Disk Access. */
export function isFullDiskAccessError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /authorization denied|unable to open|operation not permitted/i.test(msg);
}

export const FULL_DISK_ACCESS_HINT =
  "Cannot read the Apple address book — grant Full Disk Access to whatever " +
  "runs this (System Settings → Privacy & Security → Full Disk Access), then retry.";

// Run directly to see what the reader sees. Reads only; nothing reaches Postgres.
if (process.argv[1]?.endsWith("apple-contacts-reader.ts")) {
  const all = readAppleContacts(null);
  console.log(`${sourceDatabases().length} source database(s), ${all.length} contacts parsed`);
  for (const c of all.slice(0, 5)) {
    const p = c.person;
    console.log(
      `  ${p.fullName} | ${p.phoneNumbers.join(", ") || "no phone"} | ` +
        `${p.emails.join(", ") || "no email"}${p.birthday ? ` | b ${p.birthday}` : ""}`,
    );
  }
  console.log(`latest touchedAt: ${latestTouchedAt()} (apple epoch)`);
}
