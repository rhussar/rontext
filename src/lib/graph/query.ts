import { and, eq, gte, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { contactEntities, contacts, entities, entityLogos } from "@/db/schema";

/**
 * A company is only worth drawing if at least this many people work(ed) there.
 * A hub with one member connects nobody — most entities are singletons, and
 * rendering them turns the canvas into confetti.
 *
 * Lives in a plain module (not "use server") so scripts and the logo action
 * can import it — the old copy was stranded unexported behind the
 * async-exports-only rule and got hand-copied into four files.
 */
export const MIN_HUB_SIZE = 2;

export type GraphPerson = {
  id: number;
  name: string;
  company: string | null;
  title: string | null;
};

export type GraphCompany = {
  id: number;
  /** Full name — used in the detail panel */
  name: string;
  /** Canvas label: parent name stripped, then length-capped */
  shortLabel: string;
  memberCount: number;
  /** A cached logo exists at /api/logos/<id>; otherwise draw a plain circle */
  hasLogo: boolean;
  /**
   * Logo updated_at as epoch ms — appended to the image URL so replacing a
   * logo busts the route's day-long Cache-Control instead of showing stale art.
   */
  logoV: number | null;
};

export type GraphEdge = {
  /** contact id */
  p: number;
  /** company entity id */
  e: number;
};

export type GraphData = {
  people: GraphPerson[];
  companies: GraphCompany[];
  edges: GraphEdge[];
  /** Contacts with no shared employer — real, and deliberately not drawn */
  unconnectedCount: number;
  totalContacts: number;
};

const MAX_LABEL = 26;

/**
 * "Couri Hatchery Business Incubator at Syracuse University" is 56 characters
 * and collides with half the canvas. Inside a cluster that already shows the
 * parent as its hub, repeating the parent is pure noise — so drop it, then cap
 * what's left.
 */
function canvasLabel(name: string, parentName: string | null): string {
  let s = name;
  if (parentName) {
    const p = parentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    s = s
      .replace(new RegExp(`\\s*(?:[-–—]|at|of|,)?\\s*${p}\\s*$`, "i"), "")
      .replace(new RegExp(`^\\s*${p}\\s*(?:[-–—:]|)?\\s*`, "i"), "");
    s = s.trim() || name; // never strip a label down to nothing
  }
  return s.length > MAX_LABEL ? `${s.slice(0, MAX_LABEL - 1).trimEnd()}…` : s;
}

/**
 * The company core of the network: every company shared by >= MIN_HUB_SIZE
 * people, and every person employed at one.
 *
 * Companies only, by design — schools, places and groups still exist in the
 * entity tables (the enrichment pipeline keeps writing them) and may return
 * later as sub-filters; this view just doesn't read them.
 */
export async function getCompanyGraphData(): Promise<GraphData> {
  const db = getDb();

  // Parent lookup spans ALL entities, not just companies above the threshold:
  // a parent can sit below the hub threshold while its children are above it.
  const allEntities = await db
    .select({
      id: entities.id,
      type: entities.type,
      name: entities.name,
      memberCount: entities.memberCount,
      parentId: entities.parentId,
    })
    .from(entities);
  const nameById = new Map(allEntities.map((e) => [e.id, e.name]));

  const logoRows = await db
    .select({ entityId: entityLogos.entityId, updatedAt: entityLogos.updatedAt })
    .from(entityLogos);
  const logoed = new Map(logoRows.map((l) => [l.entityId, l.updatedAt.getTime()]));

  const companies: GraphCompany[] = allEntities
    .filter((e) => e.type === "company" && e.memberCount >= MIN_HUB_SIZE)
    .map((e) => ({
      id: e.id,
      name: e.name,
      shortLabel: canvasLabel(e.name, e.parentId ? (nameById.get(e.parentId) ?? null) : null),
      memberCount: e.memberCount,
      hasLogo: logoed.has(e.id),
      logoV: logoed.get(e.id) ?? null,
    }));
  const companyIds = new Set(companies.map((c) => c.id));

  // Join contacts here so archived people never enter the payload — the old
  // query leaked their edges and relied on the client silently dropping them.
  const links = await db
    .select({ p: contactEntities.contactId, e: contactEntities.entityId })
    .from(contactEntities)
    .innerJoin(entities, eq(entities.id, contactEntities.entityId))
    .innerJoin(contacts, eq(contacts.id, contactEntities.contactId))
    .where(
      and(
        eq(entities.type, "company"),
        gte(entities.memberCount, MIN_HUB_SIZE),
        eq(contactEntities.role, "employee"),
        isNull(contacts.archivedAt),
      ),
    );

  // Role sits in contact_entities' primary key, so one person can carry the
  // same (contact, entity) pair under two roles — dedupe to one drawn edge.
  const seen = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const l of links) {
    if (!companyIds.has(l.e)) continue;
    const key = `${l.p}:${l.e}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ p: l.p, e: l.e });
  }
  const personIds = new Set(edges.map((l) => l.p));

  const rows = await db
    .select({
      id: contacts.id,
      fullName: contacts.fullName,
      company: contacts.company,
      title: contacts.title,
    })
    .from(contacts)
    .where(isNull(contacts.archivedAt));

  const people: GraphPerson[] = rows
    .filter((r) => personIds.has(r.id))
    .map((r) => ({ id: r.id, name: r.fullName, company: r.company, title: r.title }));

  return {
    people,
    companies,
    edges,
    unconnectedCount: rows.length - people.length,
    totalContacts: rows.length,
  };
}
