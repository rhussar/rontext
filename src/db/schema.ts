import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const contacts = pgTable(
  "contacts",
  {
    id: serial("id").primaryKey(),
    fullName: text("full_name").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    company: text("company"),
    title: text("title"),
    headline: text("headline"),
    emails: text("emails").array().notNull().default([]),
    phoneNumbers: text("phone_numbers").array().notNull().default([]),
    linkedinUrl: text("linkedin_url"),
    birthday: date("birthday"),
    location: text("location"),
    starred: boolean("starred").notNull().default(false),
    linkedinConnectedOn: date("linkedin_connected_on"),
    lastLinkedinMessageDate: date("last_linkedin_message_date"),
    firstInteractionDate: date("first_interaction_date"),
    lastInteractionDate: date("last_interaction_date"),
    interactionSources: text("interaction_sources").array().notNull().default([]),
    meshId: text("mesh_id"),
    meshUrl: text("mesh_url"),
    source: text("source", { enum: ["import", "manual", "linkedin"] })
      .notNull()
      .default("manual"),
    lastScrapedAt: timestamp("last_scraped_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("contacts_linkedin_url_uq").on(t.linkedinUrl),
    uniqueIndex("contacts_mesh_id_uq").on(t.meshId),
  ],
);

export const groups = pgTable("groups", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  color: text("color").notNull().default("#f59e0b"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const contactGroups = pgTable(
  "contact_groups",
  {
    contactId: integer("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    groupId: integer("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.contactId, t.groupId] })],
);

export const notes = pgTable("notes", {
  id: serial("id").primaryKey(),
  contactId: integer("contact_id")
    .notNull()
    .references(() => contacts.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  source: text("source", { enum: ["imported", "manual"] })
    .notNull()
    .default("manual"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const imports = pgTable("imports", {
  id: serial("id").primaryKey(),
  filename: text("filename").notNull(),
  rowCount: integer("row_count").notNull(),
  createdCount: integer("created_count").notNull(),
  updatedCount: integer("updated_count").notNull(),
  skippedCount: integer("skipped_count").notNull(),
  notesCreated: integer("notes_created").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ------------------------------------------------------------------ *
 * Graph layer
 *
 * AI-derived data lives in its own tables, never on `contacts`. The CSV
 * import (import-core.ts) is careful never to blank existing fields, and
 * a re-import must not fight the enrichment job — keeping them separate
 * lets both stay idempotent on their own.
 * ------------------------------------------------------------------ */

export const ENTITY_TYPES = [
  "company",
  "school",
  "place",
  "industry",
  "function",
  "group",
] as const;

export const entities = pgTable(
  "entities",
  {
    id: serial("id").primaryKey(),
    type: text("type", { enum: ENTITY_TYPES }).notNull(),
    /** Canonical display name, e.g. "KPMG" */
    name: text("name").notNull(),
    /** Dedupe key: lowercased, suffix-stripped, punctuation-collapsed */
    normalizedKey: text("normalized_key").notNull(),
    aliases: text("aliases").array().notNull().default([]),
    /**
     * Self-reference used for rollup: Whitman School -> Syracuse University,
     * "Greater Chicago Area" -> Chicago metro. This is what turns 33 scattered
     * Syracuse strings into one 120-person cluster.
     */
    parentId: integer("parent_id").references((): AnyPgColumn => entities.id, {
      onDelete: "set null",
    }),
    /** Denormalized degree — drives node size and inverse-degree path weighting */
    memberCount: integer("member_count").notNull().default(0),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("entities_type_key_uq").on(t.type, t.normalizedKey),
    index("entities_parent_idx").on(t.parentId),
    index("entities_member_count_idx").on(t.memberCount),
  ],
);

export const ENTITY_ROLES = [
  "employee",
  "alum",
  "lives_in",
  "member",
  "classified_as",
] as const;

export const contactEntities = pgTable(
  "contact_entities",
  {
    contactId: integer("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    entityId: integer("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    role: text("role", { enum: ENTITY_ROLES }).notNull(),
    confidence: real("confidence").notNull().default(1),
    source: text("source", { enum: ["rule", "llm", "manual", "import"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // role is part of the PK: someone can be both employee and alum of Syracuse
  (t) => [
    primaryKey({ columns: [t.contactId, t.entityId, t.role] }),
    index("contact_entities_entity_idx").on(t.entityId),
  ],
);

export const SENIORITIES = [
  "student",
  "entry",
  "analyst",
  "associate",
  "manager",
  "director",
  "vp",
  "partner",
  "c_level",
  "founder",
] as const;

export const contactEnrichment = pgTable("contact_enrichment", {
  contactId: integer("contact_id")
    .primaryKey()
    .references(() => contacts.id, { onDelete: "cascade" }),
  seniority: text("seniority", { enum: SENIORITIES }),
  jobFunction: text("job_function"),
  /** One-line profile summary — also the embedding source if we add pgvector later */
  summary: text("summary"),
  model: text("model"),
  promptVersion: integer("prompt_version").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const ENRICHMENT_KINDS = [
  "companies",
  "locations",
  "titles",
  "link",
  "layout",
] as const;

export const enrichmentJobs = pgTable("enrichment_jobs", {
  id: serial("id").primaryKey(),
  kind: text("kind", { enum: ENRICHMENT_KINDS }).notNull(),
  status: text("status", { enum: ["pending", "running", "done", "error"] })
    .notNull()
    .default("pending"),
  total: integer("total").notNull().default(0),
  processed: integer("processed").notNull().default(0),
  /** Resume point — the runner processes one batch per invocation */
  cursor: integer("cursor").notNull().default(0),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

/** Persisted ForceAtlas2 layout so positions are stable and page load is instant. */
export const graphNodes = pgTable(
  "graph_nodes",
  {
    nodeType: text("node_type", { enum: ["person", "entity"] }).notNull(),
    nodeId: integer("node_id").notNull(),
    x: real("x").notNull(),
    y: real("y").notNull(),
    degree: integer("degree").notNull().default(0),
    /** Louvain cluster id */
    community: integer("community"),
    layoutVersion: integer("layout_version").notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.nodeType, t.nodeId] })],
);

export const contactChanges = pgTable(
  "contact_changes",
  {
    id: serial("id").primaryKey(),
    contactId: integer("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    field: text("field").notNull(),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    source: text("source", { enum: ["linkedin", "import", "manual"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("contact_changes_created_at_idx").on(t.createdAt.desc()),
    index("contact_changes_contact_id_idx").on(t.contactId),
  ],
);

export const scrapeRuns = pgTable("scrape_runs", {
  id: serial("id").primaryKey(),
  profileCount: integer("profile_count").notNull(),
  createdCount: integer("created_count").notNull(),
  updatedCount: integer("updated_count").notNull(),
  unchangedCount: integer("unchanged_count").notNull(),
  changeCount: integer("change_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Photo bytes live in their own table so listPeople() never loads them.
export const contactPhotos = pgTable("contact_photos", {
  contactId: integer("contact_id")
    .primaryKey()
    .references(() => contacts.id, { onDelete: "cascade" }),
  data: text("data").notNull(), // base64-encoded image
  contentType: text("content_type").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
export type Group = typeof groups.$inferSelect;
export type Note = typeof notes.$inferSelect;
export type ContactChange = typeof contactChanges.$inferSelect;
export type NewContactChange = typeof contactChanges.$inferInsert;
export type Entity = typeof entities.$inferSelect;
export type NewEntity = typeof entities.$inferInsert;
export type ContactEntity = typeof contactEntities.$inferSelect;
export type EntityType = (typeof ENTITY_TYPES)[number];
export type EntityRole = (typeof ENTITY_ROLES)[number];
export type Seniority = (typeof SENIORITIES)[number];
export type EnrichmentJob = typeof enrichmentJobs.$inferSelect;
export type EnrichmentKind = (typeof ENRICHMENT_KINDS)[number];
export type GraphNode = typeof graphNodes.$inferSelect;
