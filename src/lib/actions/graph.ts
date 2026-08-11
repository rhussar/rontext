"use server";

import { eq, gte, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { contactEntities, contacts, entities, entityLogos, notes } from "@/db/schema";
import { avatarHex } from "@/lib/format";
import type { EntityType } from "@/db/schema";

/**
 * An entity is only worth drawing if at least this many people share it.
 * A hub with one member connects nobody — 941 of our 1,118 entities are
 * singletons, and rendering them turns the canvas into confetti.
 */
// Not exported: a "use server" module may only export async functions.
const MIN_HUB_SIZE = 2;

export type GraphPerson = {
  id: number;
  name: string;
  company: string | null;
  title: string | null;
  color: string;
  starred: boolean;
  /** Tie-strength inputs, also used by pathfinding */
  sources: string[];
  lastInteraction: string | null;
  connectedOn: string | null;
  hasNotes: boolean;
};

export type GraphEntity = {
  id: number;
  type: EntityType;
  /** Full name — used in the detail panel */
  name: string;
  /** Canvas label: parent name stripped, then length-capped */
  shortLabel: string;
  memberCount: number;
  parentId: number | null;
  /** A cached logo exists at /api/logos/<id>; otherwise draw a plain circle */
  hasLogo: boolean;
  /**
   * Logo updated_at as epoch ms — appended to the image URL so replacing a
   * logo busts the route's day-long Cache-Control instead of showing stale art.
   */
  logoV: number | null;
};

const MAX_LABEL = 26;

/**
 * "Couri Hatchery Business Incubator at Syracuse University" is 56 characters
 * and collides with half the canvas. Inside a cluster that already shows
 * Syracuse University as its hub, repeating the parent is pure noise — so drop
 * it, then cap what's left.
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

export type GraphEdge = {
  /** contact id */
  p: number;
  /** entity id */
  e: number;
  role: string;
};

export type GraphData = {
  people: GraphPerson[];
  entities: GraphEntity[];
  edges: GraphEdge[];
  /** Contacts with no shared affiliation — real, and deliberately not drawn */
  isolatedCount: number;
  totalContacts: number;
};

/**
 * The connected core of the network: every entity shared by >= MIN_HUB_SIZE
 * people, and every person attached to one.
 *
 * Deliberately does not reuse `listPeople()` — that returns a column subset
 * without `interactionSources` or `linkedinConnectedOn`, which the tie-strength
 * weighting needs.
 */
export async function getGraphData(): Promise<GraphData> {
  const db = getDb();

  const allEntities = await db
    .select({
      id: entities.id,
      type: entities.type,
      name: entities.name,
      memberCount: entities.memberCount,
      parentId: entities.parentId,
    })
    .from(entities);

  // Parent lookup spans all entities: a parent can sit below the hub
  // threshold while its children are above it.
  const nameById = new Map(allEntities.map((e) => [e.id, e.name]));

  const logoRows = await db
    .select({ entityId: entityLogos.entityId, updatedAt: entityLogos.updatedAt })
    .from(entityLogos);
  const logoed = new Map(logoRows.map((l) => [l.entityId, l.updatedAt.getTime()]));

  const hubs: GraphEntity[] = allEntities
    .filter((e) => e.memberCount >= MIN_HUB_SIZE)
    .map((e) => ({
      ...e,
      shortLabel: canvasLabel(e.name, e.parentId ? (nameById.get(e.parentId) ?? null) : null),
      hasLogo: logoed.has(e.id),
      logoV: logoed.get(e.id) ?? null,
    }));

  const hubIds = new Set(hubs.map((h) => h.id));

  const links = await db
    .select({
      p: contactEntities.contactId,
      e: contactEntities.entityId,
      role: contactEntities.role,
    })
    .from(contactEntities)
    .innerJoin(entities, eq(entities.id, contactEntities.entityId))
    .where(gte(entities.memberCount, MIN_HUB_SIZE));

  const edges = links.filter((l) => hubIds.has(l.e));
  const personIds = new Set(edges.map((l) => l.p));

  const rows = await db
    .select({
      id: contacts.id,
      fullName: contacts.fullName,
      company: contacts.company,
      title: contacts.title,
      starred: contacts.starred,
      sources: contacts.interactionSources,
      lastInteraction: contacts.lastInteractionDate,
      connectedOn: contacts.linkedinConnectedOn,
    })
    .from(contacts)
    .where(isNull(contacts.archivedAt));

  const noteCounts = await db
    .select({ contactId: notes.contactId })
    .from(notes)
    .groupBy(notes.contactId);
  const withNotes = new Set(noteCounts.map((n) => n.contactId));

  const people: GraphPerson[] = rows
    .filter((r) => personIds.has(r.id))
    .map((r) => ({
      id: r.id,
      name: r.fullName,
      company: r.company,
      title: r.title,
      color: avatarHex(r.fullName),
      starred: r.starred,
      sources: r.sources,
      lastInteraction: r.lastInteraction,
      connectedOn: r.connectedOn,
      hasNotes: withNotes.has(r.id),
    }));

  return {
    people,
    entities: hubs,
    edges,
    isolatedCount: rows.length - people.length,
    totalContacts: rows.length,
  };
}
