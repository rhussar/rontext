/**
 * Seed the DEMO database with generated people.
 *
 *   set -a && source .env.local && set +a && npm run seed:demo
 *
 * Reads DEMO_DATABASE_URL (falling back to DATABASE_URL) and refuses to run
 * unless that URL's database is named exactly `rontext_demo` — it TRUNCATES
 * every table, so the name check is the whole safety story. A second guard
 * refuses a database that has contacts but no demo marker: the only thing it
 * will wipe is a database it (or an earlier run of it) filled.
 *
 * Run WITHOUT DEMO_MODE=1: that flag makes the app's DB accessor read-only,
 * which would block the very writes this script exists to make.
 *
 * Deterministic: a seeded PRNG means every run produces the same people, so
 * screenshots stay stable and a reseed is a true reset. Dates are relative
 * to "now" so reminders and birthdays keep landing in the right windows.
 *
 * Contacts go in through importCsvText() — the real importer — so the
 * `imports` row, imported notes and group creation all happen the way they
 * do for a user. Everything else is inserted directly.
 */
import Papa from "papaparse";
import { eq, getTableName, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";

const target = process.env.DEMO_DATABASE_URL ?? process.env.DATABASE_URL;
if (!target) {
  console.error("Set DEMO_DATABASE_URL (or DATABASE_URL) to the demo database.");
  process.exit(1);
}
if (process.env.DEMO_MODE === "1") {
  console.error("Unset DEMO_MODE before seeding — it makes the DB accessor read-only.");
  process.exit(1);
}
// getDb() reads DATABASE_URL lazily on first use, which happens well after
// this line — so the import below can stay static.
process.env.DATABASE_URL = target;

import { getDb } from "../src/db";
import * as schema from "../src/db/schema";
import {
  appState,
  applications,
  contactChanges,
  contactEducation,
  contactEntities,
  contacts,
  drafts,
  entities,
  githubRepoStats,
  notes,
  reminders,
  scrapeRuns,
  socialAccountMetrics,
  socialPostMetrics,
  socialPosts,
  socialSyncRuns,
  syncRuns,
} from "../src/db/schema";
import { DEMO_DB_NAME, DEMO_SEED_KEY } from "../src/lib/demo";
import { CSV_COLUMNS } from "../src/lib/export";
import { importCsvText } from "../src/lib/import-core";
import {
  rollupInteractions,
  upsertInteractionPeriods,
  upsertInteractions,
  type InteractionInput,
  type InteractionPeriodInput,
} from "../src/lib/interactions";
import { normalizeOrgKey } from "../src/lib/graph/normalize";
import {
  APPLICATIONS,
  CITIES,
  COMPANIES,
  DRAFT_SEEDS,
  EVENTS,
  FIRST_NAMES,
  IMPORTED_NOTES,
  LAST_NAMES,
  NOTE_TEMPLATES,
  PERSONA,
  PROMOTIONS,
  REMINDER_BODIES,
  SCHOOLS,
  SOCIAL_POSTS,
  TAGLINES,
  TITLES,
  TOPICS,
  type DemoCity,
  type DemoCompany,
  type DemoSchool,
} from "./demo-data";

// ---------------------------------------------------------------- random

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260903);
const chance = (p: number) => rnd() < p;
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)];
function weighted<T extends { weight: number }>(arr: readonly T[]): T {
  const total = arr.reduce((s, x) => s + x.weight, 0);
  let r = rnd() * total;
  for (const x of arr) {
    r -= x.weight;
    if (r <= 0) return x;
  }
  return arr[arr.length - 1];
}
const hex4 = () => int(0, 0xffff).toString(16).padStart(4, "0");

// ------------------------------------------------------------------ dates

const NOW = new Date();
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);
const daysAhead = (n: number) => new Date(NOW.getTime() + n * DAY);
/** Same day, 10:00 local — the app's default reminder time. */
const at10 = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 10, 0, 0);
/** Whole months between `d` and now, floored at 0. */
const monthsAgo = (d: Date) =>
  Math.max(0, (NOW.getUTCFullYear() - d.getUTCFullYear()) * 12 + NOW.getUTCMonth() - d.getUTCMonth());
const iso = (d: Date) => d.toISOString().slice(0, 10);
/** First of the month, `offset` months back, as "YYYY-MM-01". */
function monthStart(offset: number): string {
  const d = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - offset, 1));
  return d.toISOString().slice(0, 10);
}

// ----------------------------------------------------------------- people

type Person = {
  first: string;
  last: string;
  full: string;
  company: DemoCompany | null;
  pastCompany: DemoCompany | null;
  title: string | null;
  headline: string | null;
  emails: string[];
  phones: string[];
  linkedin: string | null;
  birthday: string | null;
  city: DemoCity | null;
  school: DemoSchool | null;
  degree: string | null;
  gradYear: number | null;
  groups: string[];
  starred: boolean;
  connectedOn: string | null;
  lastLinkedinMessage: string | null;
  firstInteraction: string | null;
  lastInteraction: string | null;
  sources: string[];
  meshId: string | null;
  importedNote: string | null;
};

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

const domain = (c: DemoCompany) => `${slug(c.name)}.example.com`;

function fill(template: string, p: Person, other: Person): string {
  return template
    .replace(/\{first\}/g, p.first)
    .replace(/\{company\}/g, p.company?.name ?? "their company")
    .replace(/\{other\}/g, other.full)
    .replace(/\{event\}/g, pick(EVENTS))
    .replace(/\{topic\}/g, pick(TOPICS))
    .replace(/\{city\}/g, pick(CITIES).name);
}

function makePeople(count: number): Person[] {
  const seen = new Set<string>();
  const out: Person[] = [];
  while (out.length < count) {
    const first = pick(FIRST_NAMES);
    const last = pick(LAST_NAMES);
    const full = `${first} ${last}`;
    if (seen.has(full)) continue;
    seen.add(full);

    const company = chance(0.88) ? weighted(COMPANIES) : null;
    const pastCompany = company && chance(0.35) ? weighted(COMPANIES) : null;
    const title = company ? weighted(TITLES).title : chance(0.5) ? "Independent consultant" : null;
    const school = chance(0.5) ? weighted(SCHOOLS) : null;
    const gradYear = school ? (school.name.startsWith("Westbrook") ? (chance(0.8) ? 2024 : int(2018, 2025)) : int(2008, 2025)) : null;
    const city = chance(0.9) ? weighted(CITIES) : null;

    let headline: string | null = null;
    if (title && company) {
      headline = `${title} at ${company.name}`;
      if (chance(0.45)) {
        const tag = pick(TAGLINES).replace("{other}", (pastCompany ?? weighted(COMPANIES)).name);
        headline += ` · ${tag}`;
      }
    } else if (title) {
      headline = title;
    }

    const groups: string[] = [];
    if (school?.name.startsWith("Westbrook") && gradYear === 2024) groups.push("Business School '24");
    if (title?.includes("founder") || title?.includes("Founder")) groups.push("Founders");
    if (pastCompany?.name === "Northwind Analytics" || (company?.name === "Northwind Analytics" && chance(0.5)))
      groups.push("Former colleagues");

    const connected = chance(0.82);
    const connectedOn = connected ? iso(daysAgo(int(20, 2200))) : null;
    const hasInteractions = chance(0.6);
    const lastInteraction = hasInteractions ? daysAgo(int(3, 700)) : null;
    const firstInteraction = lastInteraction
      ? new Date(lastInteraction.getTime() - int(30, 1500) * DAY)
      : null;
    const sources: string[] = [];
    if (hasInteractions) {
      if (chance(0.7)) sources.push("email");
      if (chance(0.45)) sources.push("messages");
      if (connected && chance(0.4)) sources.push("linkedin");
      if (sources.length === 0) sources.push("email");
    }

    const p: Person = {
      first,
      last,
      full,
      company,
      pastCompany,
      title,
      headline,
      emails: chance(0.7)
        ? [`${slug(first)}.${slug(last)}@${company ? domain(company) : "mail.example.com"}`]
        : [],
      phones: chance(0.4) ? [`(${pick(["212", "415", "617", "312", "646"])}) 555-01${int(10, 99)}`] : [],
      linkedin: connected ? `https://www.linkedin.com/in/demo-${slug(first)}-${slug(last)}-${hex4()}` : null,
      birthday: chance(0.28) ? `${int(1975, 2000)}-${String(int(1, 12)).padStart(2, "0")}-${String(int(1, 28)).padStart(2, "0")}` : null,
      city,
      school,
      degree: school ? pick(school.degrees) : null,
      gradYear,
      groups,
      starred: chance(0.05),
      connectedOn,
      lastLinkedinMessage: connected && chance(0.3) ? iso(daysAgo(int(5, 900))) : null,
      firstInteraction: firstInteraction ? iso(firstInteraction) : null,
      lastInteraction: lastInteraction ? iso(lastInteraction) : null,
      sources,
      meshId: chance(0.7) ? `demo-${out.length + 1}` : null,
      importedNote: null,
    };
    out.push(p);
  }
  // Second pass for notes that mention other people.
  for (const p of out) {
    if (chance(0.4)) p.importedNote = fill(pick(IMPORTED_NOTES), p, pick(out));
  }
  // Birthdays inside the Home window: pin ten of them to the next 30 days.
  for (const p of out.filter((x) => x.birthday).slice(0, 10)) {
    const d = daysAhead(int(0, 28));
    p.birthday = `${int(1978, 1998)}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  }
  return out;
}

function toCsv(people: Person[]): string {
  const rows = people.map((p) => ({
    full_name: p.full,
    first_name: p.first,
    last_name: p.last,
    company: p.company?.name ?? "",
    title: p.title ?? "",
    headline: p.headline ?? "",
    emails: p.emails.join("; "),
    phone_numbers: p.phones.join("; "),
    linkedin_url: p.linkedin ?? "",
    birthday: p.birthday ?? "",
    location: p.city?.name ?? "",
    groups: [...(p.starred ? ["Starred"] : []), ...p.groups].join("; "),
    linkedin_connected_on: p.connectedOn ?? "",
    last_linkedin_message_date: p.lastLinkedinMessage ?? "",
    first_interaction_date: p.firstInteraction ?? "",
    last_interaction_date: p.lastInteraction ?? "",
    interaction_sources: p.sources.join("; "),
    mesh_id: p.meshId ?? "",
    mesh_url: p.meshId ? `https://mesh.example.com/people/${p.meshId}` : "",
    notes: p.importedNote ?? "",
  }));
  return Papa.unparse(rows, { columns: [...CSV_COLUMNS], newline: "\n" });
}

async function parallel<T>(items: T[], fn: (t: T) => Promise<unknown>, width = 8) {
  for (let i = 0; i < items.length; i += width) {
    await Promise.all(items.slice(i, i + width).map(fn));
  }
}

// ------------------------------------------------------------------- main

async function main() {
  const dbName = new URL(target!).pathname.replace(/^\//, "");
  if (dbName !== DEMO_DB_NAME) {
    console.error(`Refusing: database is "${dbName}", not "${DEMO_DB_NAME}".`);
    process.exit(1);
  }
  const db = getDb();

  const [{ n: existing }] = await db.select({ n: sql<number>`count(*)::int` }).from(contacts);
  const marker = await db.select().from(appState).where(eq(appState.key, DEMO_SEED_KEY));
  if (existing > 0 && marker.length === 0) {
    console.error("Refusing: this database has contacts but no demo marker. It is not a demo database.");
    process.exit(1);
  }

  // --- wipe ---
  const tables = Object.values(schema)
    .filter((v) => is(v, PgTable))
    .map((t) => `"${getTableName(t as PgTable)}"`);
  await db.execute(sql.raw(`TRUNCATE TABLE ${tables.join(", ")} RESTART IDENTITY CASCADE`));
  console.log(`wiped ${tables.length} tables`);

  // --- contacts via the real importer ---
  const people = makePeople(250);
  const summary = await importCsvText(toCsv(people), "demo-network.csv");
  if (!summary.ok) throw new Error(summary.error);
  console.log(`imported ${summary.created} contacts, ${summary.notesCreated} notes, groups: ${summary.groupsCreated.join(", ")}`);

  const rows = await db.select({ id: contacts.id, fullName: contacts.fullName }).from(contacts);
  const idOf = new Map(rows.map((r) => [r.fullName, r.id]));
  const id = (p: Person) => idOf.get(p.full)!;
  const other = (p: Person) => {
    let o = pick(people);
    while (o === p) o = pick(people);
    return o;
  };

  // --- per-contact fixups the CSV can't carry ---
  const recentlyAdded = people.slice(200, 215);
  const viewed = people.slice(5, 8);
  const archived = people.slice(240, 245);
  await parallel(people, async (p) => {
    const patch: Partial<typeof contacts.$inferInsert> = {
      headline: p.headline,
      hometown: chance(0.2) ? pick(CITIES).name : null,
    };
    if (p.city) {
      patch.latitude = p.city.lat + (rnd() - 0.5) * 0.08;
      patch.longitude = p.city.lon + (rnd() - 0.5) * 0.08;
      patch.geocodedAt = daysAgo(int(1, 60));
    }
    if (p.linkedin && chance(0.6)) patch.lastScrapedAt = daysAgo(int(0, 60));
    if (recentlyAdded.includes(p)) {
      patch.createdAt = daysAgo(int(0, 28));
      patch.source = pick(["manual", "linkedin", "gmail", "contacts", "calendar"] as const);
    }
    if (viewed.includes(p)) patch.lastViewedAt = daysAgo(int(0, 3));
    if (archived.includes(p)) patch.archivedAt = daysAgo(int(10, 200));
    await db.update(contacts).set(patch).where(eq(contacts.id, id(p)));
  });
  console.log("applied per-contact fixups");

  // --- manual notes ---
  const noteRows: (typeof notes.$inferInsert)[] = [];
  for (const p of people) {
    const k = chance(0.3) ? int(1, 3) : 0;
    for (let i = 0; i < k; i++) {
      noteRows.push({
        contactId: id(p),
        body: fill(pick(NOTE_TEMPLATES), p, other(p)),
        source: "manual",
        createdAt: daysAgo(int(1, 540)),
      });
    }
  }
  await db.insert(notes).values(noteRows);
  console.log(`notes: ${noteRows.length}`);

  // --- reminders: a few overdue, most upcoming, some done ---
  const reminderRows: (typeof reminders.$inferInsert)[] = [];
  const reminderPeople = people.slice(20, 36);
  reminderPeople.forEach((p, i) => {
    const overdue = i < 3;
    const done = i >= 12;
    reminderRows.push({
      contactId: id(p),
      remindAt: at10(overdue ? daysAgo(int(1, 6)) : done ? daysAgo(int(7, 40)) : daysAhead(int(1, 21))),
      body: chance(0.8) ? fill(pick(REMINDER_BODIES), p, other(p)) : null,
      completedAt: done ? daysAgo(int(1, 6)) : null,
      createdAt: daysAgo(int(7, 45)),
    });
  });
  await db.insert(reminders).values(reminderRows);
  console.log(`reminders: ${reminderRows.length}`);

  // --- drafts ---
  const draftRows: (typeof drafts.$inferInsert)[] = [];
  DRAFT_SEEDS.forEach((d, i) => {
    const p = people[40 + i];
    const body = fill(d.body, p, other(p));
    const subject = d.subject ? fill(d.subject, p, other(p)) : null;
    draftRows.push({
      contactId: id(p),
      channel: d.channel,
      subject,
      body,
      source: d.ai ? "ai" : "manual",
      generatedBody: d.ai ? body : null,
      generatedSubject: d.ai ? subject : null,
      model: d.ai ? "claude-opus-5" : null,
      promptVersion: d.ai ? 1 : null,
      sentAt: d.sent ? daysAgo(int(2, 30)) : null,
      createdAt: daysAgo(int(1, 12)),
      updatedAt: daysAgo(int(0, 1)),
    });
  });
  await db.insert(drafts).values(draftRows);
  console.log(`drafts: ${draftRows.length}`);

  // --- LinkedIn activity: headline changes + connected rows + a scrape run ---
  const changeRows: (typeof contactChanges.$inferInsert)[] = [];
  // Promotions: the headline diff Home renders comes from the person's real
  // title, and the title column moves with it — exactly what a re-scrape does.
  const promoted = people
    .filter((p) => p.company && p.linkedin && p.title && PROMOTIONS[p.title])
    .filter((_, i) => i % 3 === 0)
    .slice(0, 8);
  for (const p of promoted) {
    const from = p.headline ?? `${p.title} at ${p.company!.name}`;
    const to = from.replace(p.title!, PROMOTIONS[p.title!]);
    changeRows.push({
      contactId: id(p),
      field: "headline",
      oldValue: from,
      newValue: to,
      source: "linkedin",
      createdAt: daysAgo(int(0, 13)),
    });
    p.headline = to;
    p.title = PROMOTIONS[p.title!];
  }
  await parallel(promoted, (p) =>
    db
      .update(contacts)
      .set({ headline: p.headline, title: p.title, lastScrapedAt: daysAgo(int(0, 6)) })
      .where(eq(contacts.id, id(p))),
  );
  for (const p of recentlyAdded.filter((x) => x.linkedin).slice(0, 5)) {
    changeRows.push({
      contactId: id(p),
      field: "connected",
      oldValue: null,
      newValue: p.full,
      source: "linkedin",
      createdAt: daysAgo(int(0, 10)),
    });
  }
  for (const p of people.slice(60, 62)) {
    changeRows.push({
      contactId: id(p),
      field: "phone",
      oldValue: null,
      newValue: "(212) 555-0177",
      source: "manual",
      createdAt: daysAgo(int(0, 5)),
    });
  }
  await db.insert(contactChanges).values(changeRows);
  await db.insert(scrapeRuns).values([
    { source: "extension", profileCount: 25, createdCount: 0, updatedCount: 6, unchangedCount: 19, changeCount: 8, createdAt: daysAgo(1) },
    { source: "extension", profileCount: 25, createdCount: 0, updatedCount: 3, unchangedCount: 22, changeCount: 3, createdAt: daysAgo(2) },
    { source: "claude", profileCount: 40, createdCount: 4, updatedCount: 12, unchangedCount: 24, changeCount: 19, createdAt: daysAgo(20) },
  ]);
  await db.insert(syncRuns).values([
    { connector: "gmail", scanned: 1840, matched: 96, enriched: 61, candidates: 14, createdAt: daysAgo(1) },
    { connector: "messages", scanned: 220, matched: 48, enriched: 31, candidates: 5, createdAt: daysAgo(1) },
    { connector: "calendar", scanned: 310, matched: 40, enriched: 22, candidates: 3, createdAt: daysAgo(1) },
  ]);
  console.log(`changes: ${changeRows.length}`);

  // --- monthly interaction buckets (counts only, like the real connectors) ---
  const totals: InteractionInput[] = [];
  const periods: InteractionPeriodInput[] = [];
  for (const p of people.filter((x) => x.sources.length > 0)) {
    // Buckets end at the CSV's last-interaction month, so someone last heard
    // from a year ago stays that way after rollup — that is what feeds the
    // "haven't talked in a while" suggestions on Home and Drafts.
    const offset = p.lastInteraction ? monthsAgo(new Date(p.lastInteraction)) : 0;
    for (const src of p.sources) {
      const source = src === "email" ? "email" : src === "messages" ? "messages" : "linkedin";
      let msg = 0, sent = 0, recv = 0;
      let first: string | null = null, last: string | null = null;
      for (let m = offset; m < offset + 8; m++) {
        if (!chance(source === "messages" ? 0.6 : 0.45)) continue;
        const s = int(1, source === "messages" ? 30 : 8);
        const r = int(1, source === "messages" ? 30 : 8);
        const month = monthStart(m);
        periods.push({ contactId: id(p), source, month, messageCount: s + r, sentCount: s, receivedCount: r });
        msg += s + r; sent += s; recv += r;
        last = last ?? month;
        first = month;
      }
      if (msg > 0) totals.push({ contactId: id(p), source, firstAt: first, lastAt: last, messageCount: msg, sentCount: sent, receivedCount: recv });
    }
    if (chance(0.25)) {
      const month = monthStart(offset + int(0, 5));
      periods.push({ contactId: id(p), source: "calendar", month, messageCount: 1, sentCount: 1, receivedCount: 1 });
      totals.push({ contactId: id(p), source: "calendar", firstAt: month, lastAt: month, messageCount: 1, sentCount: 1, receivedCount: 1 });
    }
  }
  await upsertInteractions(totals);
  await upsertInteractionPeriods(periods);
  const rolled = await rollupInteractions();
  console.log(`interactions: ${totals.length} totals, ${periods.length} month rows, rolled up ${rolled}`);

  // --- graph entities: companies (drawn), schools and places (stored) ---
  const entityId = new Map<string, number>();
  async function entity(type: "company" | "school" | "place", name: string) {
    const key = `${type}:${name}`;
    if (entityId.has(key)) return entityId.get(key)!;
    const [row] = await db
      .insert(entities)
      .values({ type, name, normalizedKey: normalizeOrgKey(name) })
      .returning({ id: entities.id });
    entityId.set(key, row.id);
    return row.id;
  }
  const links: (typeof contactEntities.$inferInsert)[] = [];
  const memberCount = new Map<number, number>();
  const link = (contactId: number, eid: number, role: "employee" | "alum" | "lives_in") => {
    links.push({ contactId, entityId: eid, role, source: "import" });
    memberCount.set(eid, (memberCount.get(eid) ?? 0) + 1);
  };
  for (const p of people) {
    if (archived.includes(p)) continue;
    if (p.company) link(id(p), await entity("company", p.company.name), "employee");
    if (p.pastCompany && p.pastCompany !== p.company) link(id(p), await entity("company", p.pastCompany.name), "employee");
    if (p.school) link(id(p), await entity("school", p.school.name), "alum");
    if (p.city) link(id(p), await entity("place", p.city.name), "lives_in");
  }
  await db.insert(contactEntities).values(links).onConflictDoNothing();
  await parallel([...memberCount], ([eid, n]) =>
    db.update(entities).set({ memberCount: n }).where(eq(entities.id, eid)),
  );
  console.log(`entities: ${entityId.size}, links: ${links.length}`);

  // --- education rows (hand-entered biography, separate from the graph) ---
  const eduRows = people
    .filter((p) => p.school)
    .map((p) => ({
      contactId: id(p),
      school: p.school!.name,
      degree: p.degree,
      startYear: p.gradYear! - (p.degree?.startsWith("MBA") ? 2 : 4),
      endYear: p.gradYear,
    }));
  await db.insert(contactEducation).values(eduRows);
  console.log(`education: ${eduRows.length}`);

  // --- social: persona, posts, metrics ---
  const postRows: (typeof socialPosts.$inferInsert)[] = SOCIAL_POSTS.map((s, i) => {
    const postedAt = s.posted ? daysAgo(6 + i * 9) : null;
    const postUrl = !s.posted
      ? null
      : s.platform === "linkedin"
        ? `https://www.linkedin.com/posts/${PERSONA.linkedin.handle}_networking-activity-7${String(1000 + i).padStart(18, "0")}`
        : s.platform === "x"
          ? "https://x.com/samrivera_demo/status/1"
          : "https://www.instagram.com/p/DEMO-not-a-real-post/";
    return {
      platform: s.platform,
      body: s.body,
      source: s.ai ? "ai" : "manual",
      generatedBody: s.ai ? s.body : null,
      model: s.ai ? "claude-opus-5" : null,
      promptVersion: s.ai ? 1 : null,
      postedAt,
      postUrl,
      createdAt: daysAgo(8 + i * 9),
      updatedAt: postedAt ?? daysAgo(int(0, 3)),
    };
  });
  const postIds = await db.insert(socialPosts).values(postRows).returning({ id: socialPosts.id, postUrl: socialPosts.postUrl, platform: socialPosts.platform, postedAt: socialPosts.postedAt, body: socialPosts.body });

  const metricRows: (typeof socialAccountMetrics.$inferInsert)[] = [];
  const base = { linkedin: 2140, x: 880, instagram: 1310, github: 96 } as const;
  for (let w = 11; w >= 0; w--) {
    for (const platform of ["linkedin", "x", "instagram", "github"] as const) {
      const growth = (11 - w) * (platform === "linkedin" ? 14 : platform === "github" ? 2 : 6) + int(-3, 5);
      metricRows.push({
        platform,
        capturedAt: daysAgo(w * 7),
        followers: base[platform] + growth,
        following: platform === "github" ? 40 : int(300, 900),
        postCount: platform === "github" ? null : 120 + (11 - w),
        profileViews: platform === "linkedin" ? int(180, 420) : null,
        impressions: platform === "linkedin" ? int(6000, 14000) : null,
        extra: platform === "github" ? { totalStars: 38 + (11 - w), publicRepos: 12 } : null,
        source: platform === "github" ? "api" : "scrape",
      });
    }
  }
  await db.insert(socialAccountMetrics).values(metricRows);

  const postMetricRows: (typeof socialPostMetrics.$inferInsert)[] = [];
  for (const p of postIds.filter((x) => x.postUrl)) {
    for (let c = 2; c >= 0; c--) {
      const age = 3 - c;
      postMetricRows.push({
        platform: p.platform,
        postUrl: p.postUrl!,
        postId: p.id,
        postedAt: p.postedAt,
        excerpt: p.body.slice(0, 100),
        capturedAt: daysAgo(c * 2),
        impressions: 900 * age + int(0, 400),
        likes: 30 * age + int(0, 12),
        comments: 4 * age + int(0, 3),
        reposts: 2 * age,
        bookmarks: p.platform === "x" ? 3 * age : null,
        source: "scrape",
      });
    }
  }
  await db.insert(socialPostMetrics).values(postMetricRows);

  await db.insert(githubRepoStats).values(
    Array.from({ length: 14 }, (_, i) => ({
      repo: PERSONA.githubRepo,
      day: iso(daysAgo(13 - i)),
      views: int(8, 60),
      uniqueViews: int(4, 25),
      clones: int(0, 6),
      uniqueClones: int(0, 4),
      stars: 40 + Math.floor(i / 3),
      capturedAt: daysAgo(0),
    })),
  );
  await db.insert(socialSyncRuns).values([
    { platform: "linkedin", accountRows: 1, postRows: 1, createdAt: daysAgo(0) },
    { platform: "x", accountRows: 1, postRows: 1, createdAt: daysAgo(0) },
    { platform: "instagram", accountRows: 1, postRows: 1, createdAt: daysAgo(0) },
    { platform: "github", accountRows: 1, postRows: 0, createdAt: daysAgo(0) },
  ]);
  console.log(`social: ${postRows.length} posts, ${metricRows.length} account captures, ${postMetricRows.length} post captures`);

  // --- job applications ---
  await db.insert(applications).values(
    APPLICATIONS.map((a) => ({
      company: a.company,
      role: a.role,
      appliedOn: a.daysAgo === null ? null : iso(daysAgo(a.daysAgo)),
      url: null,
      notes: a.notes,
      createdAt: daysAgo(a.daysAgo ?? 2),
      updatedAt: daysAgo(int(0, 2)),
    })),
  );
  console.log(`applications: ${APPLICATIONS.length}`);

  // --- workspace state; the marker goes in last ---
  const profile = (name: string, handle: string, bio: string) =>
    JSON.stringify({ name, handle, bio, avatar: null });
  await db.insert(appState).values([
    { key: "workspaceName", value: PERSONA.workspaceName },
    { key: "workspaceColor", value: PERSONA.workspaceColor },
    { key: "activity_seen_at", value: daysAgo(2).toISOString() },
    { key: "socialProfile:linkedin", value: profile(PERSONA.name, PERSONA.linkedin.handle, PERSONA.linkedin.bio) },
    { key: "socialProfile:x", value: profile(PERSONA.name, PERSONA.x.handle, PERSONA.x.bio) },
    { key: "socialProfile:instagram", value: profile(PERSONA.name, PERSONA.instagram.handle, PERSONA.instagram.bio) },
    { key: "socialProfile:youtube", value: profile(PERSONA.name, PERSONA.youtube.handle, PERSONA.youtube.bio) },
    { key: "socialNotes:linkedin", value: "Post on Tuesdays. Long-form does better than links." },
    { key: DEMO_SEED_KEY, value: NOW.toISOString() },
  ]);
  console.log(`seeded ${DEMO_DB_NAME} at ${NOW.toISOString()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
