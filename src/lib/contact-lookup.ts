/**
 * "Who is this?" by identifier — the MCP `lookup_contact` tool.
 *
 * Every intake agent (meetings, email, calendar) holds an address, a number or
 * a profile URL, not a contact id, and searching by free text for those is
 * both slow and wrong (a substring of an email matches strangers). This
 * resolves each identifier exactly, with the same keys the connectors match
 * on, so an agent and a sync never disagree about who someone is:
 *
 *  - email:    trimmed + lowercased (connector-ingest's emailKey). Gmail
 *              addresses additionally ignore dots and a +tag, since Gmail
 *              delivers all of those to one inbox.
 *  - phone:    the last 10 digits, needing at least 7 (handleKey).
 *  - LinkedIn: the /in/<slug> key (linkedinKey), so any spelling of the URL
 *              finds the profile.
 *
 * An identifier matching two contacts comes back with both and `ambiguous`,
 * never a pick: a shared landline or a family email is exactly the case where
 * a guess attaches a meeting to the wrong person.
 */
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { linkedinKey } from "@/lib/contact-merge";

export type LookupMatch = {
  id: number;
  fullName: string;
  company: string | null;
  title: string | null;
  archived: boolean;
};

export type LookupResult = {
  input: string;
  kind: "email" | "phone" | "linkedin";
  matches: LookupMatch[];
  ambiguous?: true;
  /** Why an input couldn't be looked up at all. */
  invalid?: string;
};

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/** Comparison key for an email; see the module comment. */
export function emailLookupKey(raw: string): string | null {
  const e = raw.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 1 || at === e.length - 1) return null;
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  if (!GMAIL_DOMAINS.has(domain)) return e;
  return `${local.replace(/\+.*$/, "").replace(/\./g, "")}@gmail.com`;
}

/** SQL twin of emailLookupKey over one stored address `e`. */
const emailKeySql = (e: ReturnType<typeof sql>) => sql`(
  case when split_part(lower(trim(${e})), '@', 2) in ('gmail.com', 'googlemail.com')
    then regexp_replace(regexp_replace(split_part(lower(trim(${e})), '@', 1), '\\+.*$', ''), '\\.', '', 'g') || '@gmail.com'
    else lower(trim(${e}))
  end
)`;

/**
 * A text[] as ONE bind parameter. drizzle's sql template spreads a JS array
 * into a parameter per element (see intros.ts), and strings can't be inlined
 * as a literal safely — JSON in, unpacked by Postgres, is both.
 */
const textArray = (xs: string[]) =>
  sql`array(select jsonb_array_elements_text(${JSON.stringify(xs)}::jsonb))`;

export function phoneLookupKey(raw: string): string | null {
  const d = raw.replace(/\D/g, "");
  return d.length >= 7 ? d.slice(-10) : null;
}

type Row = {
  id: number;
  full_name: string;
  company: string | null;
  title: string | null;
  archived: boolean;
  email_keys: string[] | null;
  phone_keys: string[] | null;
  linkedin_url: string | null;
};

export async function lookupContacts(input: {
  emails?: string[];
  phones?: string[];
  linkedinUrls?: string[];
}): Promise<LookupResult[]> {
  const emails = (input.emails ?? []).map((raw) => ({ raw, key: emailLookupKey(raw) }));
  const phones = (input.phones ?? []).map((raw) => ({ raw, key: phoneLookupKey(raw) }));
  // linkedinKey() keys any string; only a LinkedIn URL is worth looking up.
  const profiles = (input.linkedinUrls ?? []).map((raw) => ({
    raw,
    key: /linkedin\.com\//i.test(raw) ? linkedinKey(raw) : null,
  }));

  const emailKeys = [...new Set(emails.flatMap((x) => (x.key ? [x.key] : [])))];
  const phoneKeys = [...new Set(phones.flatMap((x) => (x.key ? [x.key] : [])))];
  // Prefilter on the slug text; the exact key comparison happens below.
  const slugs = [
    ...new Set(profiles.flatMap((x) => (x.key ? [x.key.replace(/^in\//, "").split("/").pop()!] : []))),
  ];

  const clauses = [];
  if (emailKeys.length) {
    clauses.push(sql`exists (
      select 1 from unnest(c.emails) em where ${emailKeySql(sql`em`)} = any(${textArray(emailKeys)})
    )`);
  }
  if (phoneKeys.length) {
    clauses.push(sql`exists (
      select 1 from unnest(c.phone_numbers) ph
      where length(regexp_replace(ph, '\\D', '', 'g')) >= 7
        and right(regexp_replace(ph, '\\D', '', 'g'), 10) = any(${textArray(phoneKeys)})
    )`);
  }
  for (const slug of slugs) {
    clauses.push(sql`c.linkedin_url ilike ${`%${slug.replace(/[\\%_]/g, "\\$&")}%`}`);
  }

  let rows: Row[] = [];
  if (clauses.length) {
    const res = await getDb().execute<Row>(sql`
      select
        c.id, c.full_name, c.company, c.title,
        (c.archived_at is not null) as archived,
        array(select ${emailKeySql(sql`em`)} from unnest(c.emails) em) as email_keys,
        array(
          select right(regexp_replace(ph, '\\D', '', 'g'), 10) from unnest(c.phone_numbers) ph
          where length(regexp_replace(ph, '\\D', '', 'g')) >= 7
        ) as phone_keys,
        c.linkedin_url
      from contacts c
      where ${sql.join(clauses, sql` or `)}
      order by c.archived_at is not null, c.id
    `);
    rows = res.rows;
  }

  const match = (r: Row): LookupMatch => ({
    id: r.id,
    fullName: r.full_name,
    company: r.company,
    title: r.title,
    archived: r.archived,
  });
  const result = (
    raw: string,
    kind: LookupResult["kind"],
    key: string | null,
    hits: (r: Row) => boolean,
    why: string,
  ): LookupResult => {
    if (!key) return { input: raw, kind, matches: [], invalid: why };
    const matches = rows.filter(hits).map(match);
    return { input: raw, kind, matches, ...(matches.length > 1 ? { ambiguous: true as const } : {}) };
  };

  return [
    ...emails.map((x) =>
      result(x.raw, "email", x.key, (r) => !!r.email_keys?.includes(x.key!), "not an email address"),
    ),
    ...phones.map((x) =>
      result(x.raw, "phone", x.key, (r) => !!r.phone_keys?.includes(x.key!), "fewer than 7 digits"),
    ),
    ...profiles.map((x) =>
      result(
        x.raw,
        "linkedin",
        x.key,
        (r) => !!r.linkedin_url && linkedinKey(r.linkedin_url) === x.key,
        "not a LinkedIn URL",
      ),
    ),
  ];
}
