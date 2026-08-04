"use server";

import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

/**
 * Nominatim's usage policy requires a descriptive User-Agent identifying the
 * application — a default/stock agent gets blocked.
 */
function userAgent(): string {
  const contact = process.env.NOMINATIM_CONTACT;
  return contact
    ? `MeshReplica/1.0 (self-hosted personal contact tracker; ${contact})`
    : "MeshReplica/1.0 (self-hosted personal contact tracker)";
}

export type Coords = { latitude: number; longitude: number };

type LookupResult = Coords | "miss" | "error";

/**
 * LinkedIn writes locations as "New York New York United States" — no commas —
 * and free-text search reads that as the New York New York casino in Las Vegas.
 * "…Metropolitan Area" matches nothing at all. Trimming the editorial suffixes
 * and asking for settlements resolves both.
 */
function normalizeQuery(raw: string): string {
  return raw
    .replace(/\b(greater|metropolitan|metro)\b/gi, " ")
    .replace(/\b(area|region)\b/gi, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/^[\s,]+|[\s,]+$/g, "")
    .trim();
}

async function query(
  q: string,
  settlementsOnly: boolean,
): Promise<LookupResult> {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set("q", q);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");
  if (settlementsOnly) url.searchParams.set("featureType", "settlement");

  try {
    const res = await fetch(url, { headers: { "User-Agent": userAgent() } });
    if (!res.ok) return "error";
    const rows = (await res.json()) as Array<{ lat: string; lon: string }>;
    const top = rows[0];
    if (!top) return "miss";
    // Nominatim returns lat/lon as strings, not numbers.
    const latitude = Number(top.lat);
    const longitude = Number(top.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return "miss";
    return { latitude, longitude };
  } catch {
    return "error";
  }
}

async function lookup(raw: string): Promise<LookupResult> {
  const q = normalizeQuery(raw);
  if (!q) return "miss";

  const settlement = await query(q, true);
  if (settlement !== "miss") return settlement;

  // Country- or region-only strings ("United Kingdom") aren't settlements.
  // Spaced out to stay inside Nominatim's 1 request/second ceiling.
  await new Promise((r) => setTimeout(r, 1100));
  return query(q, false);
}

/**
 * Resolve a contact's free-text location to coordinates once, then cache forever.
 * Called fire-and-forget from the detail panel, so lookups are naturally paced by
 * how fast a human opens people — well under Nominatim's 1 req/sec ceiling.
 */
export async function ensureGeocoded(contactId: number): Promise<Coords | null> {
  const db = getDb();
  const [contact] = await db
    .select({
      location: contacts.location,
      latitude: contacts.latitude,
      longitude: contacts.longitude,
      geocodedAt: contacts.geocodedAt,
    })
    .from(contacts)
    .where(eq(contacts.id, contactId));

  if (!contact?.location?.trim()) return null;

  if (contact.geocodedAt) {
    return contact.latitude != null && contact.longitude != null
      ? { latitude: contact.latitude, longitude: contact.longitude }
      : null;
  }

  const result = await lookup(contact.location.trim());

  // Transient failure: leave geocodedAt null so a later open retries. Stamping it
  // here would blind this contact's map permanently over one bad response.
  if (result === "error") return null;

  if (result === "miss") {
    await db
      .update(contacts)
      .set({ geocodedAt: new Date() })
      .where(eq(contacts.id, contactId));
    return null;
  }

  await db
    .update(contacts)
    .set({
      latitude: result.latitude,
      longitude: result.longitude,
      geocodedAt: new Date(),
    })
    .where(eq(contacts.id, contactId));
  return result;
}
