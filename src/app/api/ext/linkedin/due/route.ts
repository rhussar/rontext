/**
 * GET /api/ext/linkedin/due?limit=N — which profiles the extension may visit
 * today, and how many it has left.
 *
 * The list is the linkedin-sync skill's `--select` order (stalest first,
 * starred get a 21-day head start), filtered to profiles not scraped in the
 * last 14 days so a fully-fresh network yields an empty list and the
 * extension idles. `remaining` is the Settings cap minus today's server-side
 * visit count — the extension keeps its own tally too, but this is the one
 * that can't be bypassed. `limit=0` is a plain status probe for the options
 * page's "Test connection".
 */
import { and, isNotNull, isNull, or, sql, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { appState, contacts } from "@/db/schema";
import { getSettings } from "@/lib/actions/settings";
import { extAuthorized, extJson, extOptions, extUnauthorized, stampExtensionSeen, visitsKey } from "@/lib/ext-auth";

export const dynamic = "force-dynamic";

const FRESH_DAYS = 14;

export function OPTIONS() {
  return extOptions();
}

export async function GET(req: Request) {
  if (!(await extAuthorized(req))) return extUnauthorized();
  const url = new URL(req.url);
  const limit = Math.max(0, Math.min(30, Number(url.searchParams.get("limit") ?? "15") || 0));

  const [settings, [visited]] = await Promise.all([
    getSettings(),
    getDb()
      .select({ n: sql<number>`coalesce(nullif(${appState.value}, ''), '0')::int` })
      .from(appState)
      .where(sql`${appState.key} = ${visitsKey()}`),
  ]);
  await stampExtensionSeen(req);
  const cap = settings.linkedinDailyVisits;
  const visitedToday = visited?.n ?? 0;
  const remaining = Math.max(0, cap - visitedToday);
  const take = Math.min(limit, remaining);

  const cutoff = new Date(Date.now() - FRESH_DAYS * 86_400_000);
  const profiles = take
    ? await getDb()
        .select({ contactId: contacts.id, url: contacts.linkedinUrl, name: contacts.fullName })
        .from(contacts)
        .where(
          and(
            isNotNull(contacts.linkedinUrl),
            isNull(contacts.archivedAt),
            or(isNull(contacts.lastScrapedAt), lt(contacts.lastScrapedAt, cutoff)),
          ),
        )
        .orderBy(
          sql`coalesce(${contacts.lastScrapedAt}, timestamptz '1970-01-01')
              + case when ${contacts.starred} then interval '0 days' else interval '21 days' end asc`,
        )
        .limit(take)
    : [];

  return extJson({ ok: true, cap, visitedToday, remaining, profiles });
}
