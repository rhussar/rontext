import {
  boolean,
  date,
  doublePrecision,
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
    source: text("source", {
      enum: ["import", "manual", "linkedin", "gmail", "messages"],
    })
      .notNull()
      .default("manual"),
    lastScrapedAt: timestamp("last_scraped_at", { withTimezone: true }),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    /**
     * Cache stamp for the Nominatim lookup of `location`. Set on both a hit and a
     * confirmed miss so we never re-query the same string; left null on transient
     * network/HTTP errors so those retry. Cleared when `location` is edited.
     */
    geocodedAt: timestamp("geocoded_at", { withTimezone: true }),
    /**
     * Cache stamp for the avatar lookup behind scripts/backfill-photos.ts, with
     * the same contract as `geocodedAt`: set on a hit AND on a confirmed miss
     * (the provider answered, this person simply has no photo), left null on
     * transient errors so those retry. A miss must never be recorded as an empty
     * contact_photos row — `hasPhoto` is derived from that row existing, so it
     * would light up blank avatars app-wide.
     */
    photoCheckedAt: timestamp("photo_checked_at", { withTimezone: true }),
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

export const reminders = pgTable("reminders", {
  id: serial("id").primaryKey(),
  contactId: integer("contact_id")
    .notNull()
    .references(() => contacts.id, { onDelete: "cascade" }),
  remindAt: timestamp("remind_at", { withTimezone: true }).notNull(),
  body: text("body"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const DRAFT_CHANNELS = ["email", "sms", "linkedin"] as const;

/**
 * An outreach message written but not yet sent. `sentAt` is the open/closed
 * marker rather than a boolean, exactly like `reminders.completedAt` — Home
 * filters on `is null` the same way, and a boolean would throw away *when*.
 */
export const drafts = pgTable(
  "drafts",
  {
    id: serial("id").primaryKey(),
    contactId: integer("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    channel: text("channel", { enum: DRAFT_CHANNELS }).notNull(),
    /** Email only — null on sms and linkedin, which have no subject line. */
    subject: text("subject"),
    body: text("body").notNull().default(""),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Drafts are the one thing here you edit repeatedly; Home sorts on this. */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("drafts_contact_id_idx").on(t.contactId)],
);

/**
 * Pairs explicitly marked "not the same person", so the duplicates queue stops
 * re-suggesting them. Always stored with the lower id in `contactIdA`.
 */
export const dismissedDuplicates = pgTable(
  "dismissed_duplicates",
  {
    contactIdA: integer("contact_id_a")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    contactIdB: integer("contact_id_b")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.contactIdA, t.contactIdB] })],
);

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

/**
 * Cached company logos, keyed by entity. Mirrors `contact_photos`: the image
 * is fetched once server-side and stored here, so the browser never calls a
 * third-party icon service and the graph still renders offline.
 */
export const entityLogos = pgTable("entity_logos", {
  entityId: integer("entity_id")
    .primaryKey()
    .references(() => entities.id, { onDelete: "cascade" }),
  data: text("data").notNull(), // base64-encoded PNG
  contentType: text("content_type").notNull(),
  /** The domain the logo was fetched for — lets a re-fetch skip unchanged rows */
  domain: text("domain").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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
    source: text("source", {
      enum: ["linkedin", "import", "manual", "gmail", "messages"],
    }).notNull(),
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

/* ------------------------------------------------------------------ *
 * Connectors: Gmail + Messages
 *
 * Both run locally on the Mac and push here — nothing in this section is
 * ever a credential. Gmail's refresh token lives in ~/.mesh-replica/, and
 * chat.db never leaves the machine. Only counts and dates land in Postgres.
 * ------------------------------------------------------------------ */

/**
 * Aggregate interaction record, one row per contact per source — not per
 * message. Keeps the table at ~3 rows per contact and makes a re-sync a
 * plain upsert. Deliberately holds no subjects and no bodies.
 *
 * `source` uses the vocabulary already in contacts.interactionSources
 * ("email", "messages", "linkedin") rather than connector names, so the
 * rollup can union straight into that column.
 */
export const interactions = pgTable(
  "interactions",
  {
    contactId: integer("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    source: text("source", { enum: ["email", "messages", "linkedin"] }).notNull(),
    firstAt: date("first_at"),
    lastAt: date("last_at"),
    messageCount: integer("message_count").notNull().default(0),
    sentCount: integer("sent_count").notNull().default(0),
    receivedCount: integer("received_count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.contactId, t.source] })],
);

/**
 * People the connectors found who aren't in the CRM yet. Nothing here is a
 * contact until the user accepts it from the Discovered tab — a connector
 * must never auto-create, or one sync buries the CRM in newsletters.
 *
 * A re-sync updates counts on a `pending` row and leaves `dismissed` rows
 * alone, so declining someone declines them permanently.
 */
export const contactCandidates = pgTable(
  "contact_candidates",
  {
    id: serial("id").primaryKey(),
    source: text("source", { enum: ["gmail", "messages"] }).notNull(),
    /** Lowercased email, or phone in whatever form the handle arrived as. */
    handle: text("handle").notNull(),
    /** From the From: header. Always null for iMessage — chat.db has no names. */
    displayName: text("display_name"),
    messageCount: integer("message_count").notNull().default(0),
    sentCount: integer("sent_count").notNull().default(0),
    receivedCount: integer("received_count").notNull().default(0),
    firstAt: date("first_at"),
    lastAt: date("last_at"),
    status: text("status", { enum: ["pending", "accepted", "dismissed"] })
      .notNull()
      .default("pending"),
    /** Set when accepted — the contact this became. */
    contactId: integer("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("contact_candidates_source_handle_uq").on(t.source, t.handle),
    index("contact_candidates_status_idx").on(t.status),
  ],
);

/**
 * What the three denormalized interaction columns held *before* any connector
 * touched a contact, captured once per contact and never overwritten.
 *
 * The rollup only ever widens (a 12-month window must not erase a 2014 date),
 * which means the pre-sync values can't be recomputed from what's left after a
 * revert — the CSV-seeded dates live nowhere else. Without this snapshot,
 * revert-connector.ts could undo everything except the dates it moved.
 */
export const contactRollupBaseline = pgTable("contact_rollup_baseline", {
  contactId: integer("contact_id")
    .primaryKey()
    .references(() => contacts.id, { onDelete: "cascade" }),
  firstInteractionDate: date("first_interaction_date"),
  lastInteractionDate: date("last_interaction_date"),
  interactionSources: text("interaction_sources").array().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per connector run. The Settings card derives "Connected" from the
 * existence of a row here, exactly as LinkedIn derives it from scrape_runs.
 * LinkedIn keeps its own table; folding it in here is a later cleanup.
 */
export const syncRuns = pgTable(
  "sync_runs",
  {
    id: serial("id").primaryKey(),
    connector: text("connector", { enum: ["gmail", "messages"] }).notNull(),
    /** Handles/addresses considered after filtering. */
    scanned: integer("scanned").notNull().default(0),
    matched: integer("matched").notNull().default(0),
    enriched: integer("enriched").notNull().default(0),
    candidates: integer("candidates").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sync_runs_created_at_idx").on(t.createdAt.desc())],
);

// Photo bytes live in their own table so listPeople() never loads them.
export const contactPhotos = pgTable("contact_photos", {
  contactId: integer("contact_id")
    .primaryKey()
    .references(() => contacts.id, { onDelete: "cascade" }),
  data: text("data").notNull(), // base64-encoded image
  contentType: text("content_type").notNull(),
  /**
   * Where the bytes came from. Provenance matters because the bulk backfill can
   * write ~1k rows in one run: without this, undoing a bad run would also take
   * out the photos pasted in by hand. Defaulting to "manual" is already correct
   * for every row that predates this column.
   */
  source: text("source", {
    enum: ["manual", "vcard", "linkedin", "unavatar"],
  })
    .notNull()
    .default("manual"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Tiny single-user key/value store — currently just the activity feed's read marker. */
export const appState = pgTable("app_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
export type Group = typeof groups.$inferSelect;
export type Note = typeof notes.$inferSelect;
export type Reminder = typeof reminders.$inferSelect;
export type Draft = typeof drafts.$inferSelect;
export type DraftChannel = (typeof DRAFT_CHANNELS)[number];
export type ContactChange = typeof contactChanges.$inferSelect;
export type NewContactChange = typeof contactChanges.$inferInsert;
export type Interaction = typeof interactions.$inferSelect;
export type InteractionSource = Interaction["source"];
export type ContactCandidate = typeof contactCandidates.$inferSelect;
export type SyncRun = typeof syncRuns.$inferSelect;
export type Connector = SyncRun["connector"];
export type Entity = typeof entities.$inferSelect;
export type NewEntity = typeof entities.$inferInsert;
export type ContactEntity = typeof contactEntities.$inferSelect;
export type EntityType = (typeof ENTITY_TYPES)[number];
export type EntityRole = (typeof ENTITY_ROLES)[number];
export type Seniority = (typeof SENIORITIES)[number];
export type EnrichmentJob = typeof enrichmentJobs.$inferSelect;
export type EnrichmentKind = (typeof ENRICHMENT_KINDS)[number];
export type GraphNode = typeof graphNodes.$inferSelect;
