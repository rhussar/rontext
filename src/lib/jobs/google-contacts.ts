/**
 * Google Contacts → fill gaps on existing people. The address-book importer's
 * fold (applyParsedPeople) fed from the People API instead of a .vcf upload,
 * which makes this the first *automatic* source of birthdays — LinkedIn never
 * has them, and 1,800 of 1,801 contacts had none until the vCard import.
 *
 * Fill-gaps only, never overwrite, never create: same rules as the file
 * importer, and creating would flood the CRM with every one-off address
 * Google auto-saved. People who don't match are simply counted as unmatched.
 * Photos are skipped on purpose — People API photo URLs are mostly the
 * default silhouette, and unavatar already covers real ones.
 *
 * Needs the contacts.readonly scope: a grant migrated from the old Desktop
 * pairing is Gmail-only, so this skips with a "reconnect to add Contacts"
 * message until Ronan re-consents through Settings → Accounts.
 */
import { applyParsedPeople } from "@/lib/contacts-import-core";
import { PEOPLE_API, getGoogleCredentials, googleGet, hasScope, refreshAccessToken } from "@/lib/google-auth";
import type { ParsedPerson } from "@/lib/vcard";
import type { JobContext, JobResult } from "./registry";

type Person = {
  names?: { displayName?: string; givenName?: string; familyName?: string }[];
  emailAddresses?: { value?: string }[];
  phoneNumbers?: { value?: string }[];
  birthdays?: { date?: { year?: number; month?: number; day?: number } }[];
  organizations?: { name?: string; title?: string }[];
  addresses?: { city?: string; region?: string; country?: string; formattedValue?: string }[];
};

type Page = { connections?: Person[]; nextPageToken?: string; totalPeople?: number };

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Google omits `year` for year-less birthdays; the vCard importer preserves
 * Apple's 1604 sentinel for the same case and the birthday views only read
 * month/day, so we use the same sentinel here.
 */
function birthdayOf(p: Person): string | null {
  const d = p.birthdays?.find((b) => b.date?.month && b.date?.day)?.date;
  if (!d?.month || !d.day) return null;
  return `${d.year ?? 1604}-${pad(d.month)}-${pad(d.day)}`;
}

function toParsed(p: Person): ParsedPerson | null {
  const name = p.names?.[0];
  const emails = (p.emailAddresses ?? []).map((e) => e.value?.trim() ?? "").filter(Boolean);
  const phones = (p.phoneNumbers ?? []).map((e) => e.value?.trim() ?? "").filter(Boolean);
  const fullName = name?.displayName?.trim() ?? "";
  if (!fullName && !emails.length && !phones.length) return null;
  const org = p.organizations?.[0];
  const addr = p.addresses?.[0];
  const location =
    [addr?.city, addr?.region, addr?.country].filter(Boolean).join(", ") || addr?.formattedValue || null;
  return {
    fullName,
    firstName: name?.givenName?.trim() || null,
    lastName: name?.familyName?.trim() || null,
    emails,
    phoneNumbers: phones,
    company: org?.name?.trim() || null,
    title: org?.title?.trim() || null,
    birthday: birthdayOf(p),
    location,
    note: null,
    linkedinUrl: null,
    photo: null,
  };
}

export async function googleContactsJob(ctx: JobContext): Promise<JobResult> {
  const creds = await getGoogleCredentials();
  if (!creds) {
    return { status: "skipped", message: "Google not connected — Settings → Accounts → Connect Google" };
  }
  if (!hasScope(creds, "contacts")) {
    return { status: "skipped", message: "Grant doesn't include Contacts — reconnect Google to add it" };
  }
  const token = await refreshAccessToken(creds);

  const people: ParsedPerson[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    if (Date.now() > ctx.deadline - 15_000) break;
    const page = await googleGet<Page>(token, `${PEOPLE_API}/people/me/connections`, {
      personFields: "names,emailAddresses,phoneNumbers,birthdays,organizations,addresses",
      pageSize: "1000",
      ...(pageToken ? { pageToken } : {}),
    });
    pages++;
    for (const p of page.connections ?? []) {
      const parsed = toParsed(p);
      if (parsed) people.push(parsed);
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  ctx.log(`  ${people.length} Google contacts read in ${pages} page(s)`);

  const s = await applyParsedPeople(people, { createMissing: false, sourceTag: "google-contacts" });
  if (!s.ok) throw new Error(s.error ?? "Contacts fold failed");

  return {
    status: "ok",
    message:
      `${people.length} read · ${s.matched} matched · ` +
      `${s.birthdaysAdded} birthdays, ${s.emailsAdded} emails, ${s.phonesAdded} phones added`,
    summary: {
      read: people.length,
      matched: s.matched,
      unmatched: s.unmatched,
      birthdaysAdded: s.birthdaysAdded,
      emailsAdded: s.emailsAdded,
      phonesAdded: s.phonesAdded,
      fieldsFilled: s.fieldsFilled,
    },
  };
}
