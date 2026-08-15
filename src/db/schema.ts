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
export const DRAFT_SOURCES = ["manual", "ai"] as const;

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
    /**
     * Who wrote the first version. "manual" is correct for every row that
     * predates AI drafting, which is why it's the default.
     */
    source: text("source", { enum: DRAFT_SOURCES }).notNull().default("manual"),
    /**
     * The model's original output, kept so "you edited this" can be *derived*
     * rather than stored — a stored flag would need every future edit path to
     * remember to set it, and one of them eventually won't. Compare trimmed:
     * createDraft stores body.trim(), so an untrimmed compare marks every
     * freshly-generated draft as edited.
     */
    generatedBody: text("generated_body"),
    generatedSubject: text("generated_subject"),
    model: text("model"),
    /**
     * Nullable on purpose, unlike contact_enrichment.promptVersion. Every row
     * there is AI-derived; most rows here are hand-typed, and stamping those
     * with a prompt version would be a lie.
     */
    promptVersion: integer("prompt_version"),
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
 * The vocabulary already in contacts.interactionSources, rather than connector
 * names, so the rollup can union straight into that column. Named once because
 * three tables now share it.
 */
export const INTERACTION_SOURCES = ["email", "messages", "linkedin"] as const;

/**
 * Aggregate interaction record, one row per contact per source — not per
 * message. Keeps the table at ~3 rows per contact and makes a re-sync a
 * plain upsert. Deliberately holds no subjects and no bodies.
 */
export const interactions = pgTable(
  "interactions",
  {
    contactId: integer("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    source: text("source", { enum: INTERACTION_SOURCES }).notNull(),
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
 * One month of interaction counts, per contact per source.
 *
 * The point of this table is that a person's timeline can show "Jul 2026 · 24
 * texts" without storing 24 message rows. Bounded at ~12 rows per contact per
 * year per source, and a quiet month simply has no row — so someone you text
 * in bursts costs three rows a year, not twelve.
 *
 * Like `interactions`, it holds counts and dates only. No subjects, no bodies.
 *
 * `month` is the first day of the month in *local* time, matching the
 * `'localtime'` conversion the chat.db reader does.
 */
export const interactionPeriods = pgTable(
  "interaction_periods",
  {
    contactId: integer("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    source: text("source", { enum: INTERACTION_SOURCES }).notNull(),
    /** First of the month, e.g. "2026-07-01". */
    month: date("month").notNull(),
    messageCount: integer("message_count").notNull().default(0),
    sentCount: integer("sent_count").notNull().default(0),
    receivedCount: integer("received_count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // contactId leads the PK, so the only hot query (one person's history) is
    // already served. The source index exists for revert-connector.ts.
    primaryKey({ columns: [t.contactId, t.source, t.month] }),
    index("interaction_periods_source_idx").on(t.source),
  ],
);

/**
 * One month of a correspondent's counts, as carried on a candidate row before
 * there is a contact to attach it to. Same shape as an `interaction_periods`
 * row minus the keys.
 */
export type PeriodTally = {
  /** First of the month, "YYYY-MM-01". */
  month: string;
  messageCount: number;
  sentCount: number;
  receivedCount: number;
};

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
    /**
     * The monthly breakdown, parked here until there's a contact to hang it on.
     * `interaction_periods` needs a contactId and a candidate hasn't got one,
     * so acceptCandidate() expands this into real rows on acceptance — without
     * it a newly-accepted person's timeline stays empty until the next sync.
     * Bounded by the sync window (~24 entries), so it never bloats.
     */
    periods: jsonb("periods").$type<PeriodTally[]>().notNull().default([]),
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

/**
 * Schools a person attended — many rows per contact, newest first.
 *
 * Its own table rather than columns on `contacts` because people have more
 * than one degree, and rather than `contact_entities` because that layer is
 * the *graph*: entities are deduped nodes shared across people, written by
 * the LinkedIn scrape, and rewritten by it. This is hand-entered biography
 * that must survive a re-scrape, so it is kept separate on purpose. (A later
 * pass could link `school` to an entity id for graph rollups; deliberately
 * not done now, since it would put scrape-owned data back in an editable row.)
 *
 * Years are plain integers, not dates: nobody records the day they graduated,
 * and `endYear` is null for "still there". Both are nullable so a half-known
 * entry ("Yale, no idea when") is still worth saving.
 */
export const contactEducation = pgTable(
  "contact_education",
  {
    id: serial("id").primaryKey(),
    contactId: integer("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    school: text("school").notNull(),
    /** Degree and/or field, one line — "MBA", "BS, Computer Science". */
    degree: text("degree"),
    startYear: integer("start_year"),
    /** Null means ongoing, which is why sorting has to handle nulls first. */
    endYear: integer("end_year"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("contact_education_contact_idx").on(t.contactId)],
);

/**
 * PDFs attached to a person — résumés, decks, papers.
 *
 * Same storage shape as `application_docs`: bytes base64 in their own table so
 * no contact list query ever drags them along. Unlike that table there are no
 * fixed slots and so no unique index — a person can carry any number of files,
 * and "replace" is just delete + upload. Rows are still never mutated, which is
 * what keeps the immutable Cache-Control on /api/contact-docs/[id] honest.
 */
export const contactDocs = pgTable(
  "contact_docs",
  {
    id: serial("id").primaryKey(),
    contactId: integer("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    /** The upload's original name, shown in the UI and on download. */
    filename: text("filename").notNull(),
    data: text("data").notNull(), // base64-encoded PDF
    byteSize: integer("byte_size").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("contact_docs_contact_idx").on(t.contactId)],
);

/** Tiny single-user key/value store — currently just the activity feed's read marker. */
export const appState = pgTable("app_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ------------------------------------------------------------------ *
 * Social layer
 *
 * Own-account presence, not contacts: posts written here, and metrics
 * about the owner's profiles. Metrics arrive from the social-sync skill
 * (scraping the owner's own dashboards in his logged-in Chrome — the
 * platforms' APIs don't expose personal analytics) or from the GitHub
 * REST API. Both metric tables are append-only time series: a capture
 * is a new row, never an upsert, because the sparklines depend on
 * history surviving. github_repo_stats is the one deliberate exception.
 * ------------------------------------------------------------------ */

export const SOCIAL_PLATFORMS = ["linkedin", "x", "instagram", "github"] as const;
/** Platforms you can author on. GitHub is analytics-only. */
export const SOCIAL_POST_PLATFORMS = ["linkedin", "x", "instagram"] as const;
export const METRIC_SOURCES = ["scrape", "api"] as const;

/**
 * A social post, drafted here and published by hand (or via the X API).
 * `postedAt` is the open/closed marker, exactly like drafts.sentAt.
 */
export const socialPosts = pgTable(
  "social_posts",
  {
    id: serial("id").primaryKey(),
    platform: text("platform", { enum: SOCIAL_POST_PLATFORMS }).notNull(),
    body: text("body").notNull().default(""),
    // AI provenance, mirroring drafts field-for-field (same rationale there).
    source: text("source", { enum: DRAFT_SOURCES }).notNull().default("manual"),
    generatedBody: text("generated_body"),
    model: text("model"),
    promptVersion: integer("prompt_version"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    /**
     * Permalink pasted back after posting (or returned by the X API). This is
     * the join key to social_post_metrics — the scraper only ever knows URLs,
     * not row ids.
     */
    postUrl: text("post_url"),
    /** X tweet id when posted via the API. */
    externalId: text("external_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("social_posts_updated_at_idx").on(t.updatedAt.desc())],
);

/**
 * Images attached to a post — for the platform previews and as the canonical
 * "what goes with this post" record. Bytes live here, not on social_posts,
 * for the same reason contact photo bytes have their own table: list queries
 * must never load them. Publishing them is manual: handoff means the owner
 * attaches the files in the platform's own composer (the X API path refuses
 * posts with media rather than silently dropping the images).
 */
export const socialPostMedia = pgTable(
  "social_post_media",
  {
    id: serial("id").primaryKey(),
    postId: integer("post_id")
      .notNull()
      .references(() => socialPosts.id, { onDelete: "cascade" }),
    /** 0-based display order; X shows up to 4, so writes cap at 4 per post. */
    position: integer("position").notNull().default(0),
    data: text("data").notNull(), // base64-encoded image
    contentType: text("content_type").notNull(),
    /** Pixel size at upload — the previews need aspect ratios before load. */
    width: integer("width"),
    height: integer("height"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("social_post_media_post_id_idx").on(t.postId)],
);

/**
 * One row per capture of the owner's profile-level numbers — a time series.
 * Columns are nullable because platforms disagree on what they show: only
 * LinkedIn has profileViews, Instagram (personal) has only header counts.
 */
export const socialAccountMetrics = pgTable(
  "social_account_metrics",
  {
    id: serial("id").primaryKey(),
    platform: text("platform", { enum: SOCIAL_PLATFORMS }).notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    followers: integer("followers"),
    following: integer("following"),
    postCount: integer("post_count"),
    /** LinkedIn only. */
    profileViews: integer("profile_views"),
    /** 28-day rolling where the platform shows one (LinkedIn). */
    impressions: integer("impressions"),
    /**
     * Platform-specific spillover (GitHub totalStars/publicRepos, …) — jsonb
     * like entities.metadata, so a new platform stat doesn't force a migration.
     */
    extra: jsonb("extra"),
    source: text("source", { enum: METRIC_SOURCES }).notNull(),
  },
  (t) => [
    index("social_account_metrics_platform_captured_idx").on(
      t.platform,
      t.capturedAt.desc(),
    ),
  ],
);

/**
 * Per-post snapshots — also append-only (impressions grow; keep every capture
 * so the trend is visible). Keyed by URL, not post id: posts made outside the
 * app are tracked too, they just have a null postId.
 */
export const socialPostMetrics = pgTable(
  "social_post_metrics",
  {
    id: serial("id").primaryKey(),
    platform: text("platform", { enum: SOCIAL_POST_PLATFORMS }).notNull(),
    /** Normalized at ingest: no query string, no trailing slash, x.com host. */
    postUrl: text("post_url").notNull(),
    /** Resolved at ingest when postUrl matches a social_posts row. */
    postId: integer("post_id").references(() => socialPosts.id, {
      onDelete: "set null",
    }),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    /** First ~100 chars, so external posts have something to display. */
    excerpt: text("excerpt"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    impressions: integer("impressions"),
    likes: integer("likes"),
    comments: integer("comments"),
    reposts: integer("reposts"),
    bookmarks: integer("bookmarks"),
    source: text("source", { enum: METRIC_SOURCES }).notNull(),
  },
  (t) => [
    index("social_post_metrics_url_captured_idx").on(t.postUrl, t.capturedAt.desc()),
  ],
);

/**
 * GitHub repo traffic, keyed (repo, day) and UPSERTED — the traffic API
 * returns a rolling 14-day window, so consecutive captures overlap; the
 * upsert dedupes the overlap instead of double-counting it. Data older
 * than 14 days is unrecoverable, hence "run at least weekly" in the docs.
 */
export const githubRepoStats = pgTable(
  "github_repo_stats",
  {
    id: serial("id").primaryKey(),
    /** "owner/name" */
    repo: text("repo").notNull(),
    day: date("day").notNull(),
    views: integer("views").notNull().default(0),
    uniqueViews: integer("unique_views").notNull().default(0),
    clones: integer("clones").notNull().default(0),
    uniqueClones: integer("unique_clones").notNull().default(0),
    /** Cumulative star count as of the capture that wrote this row. */
    stars: integer("stars"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("github_repo_stats_repo_day_uq").on(t.repo, t.day)],
);

/**
 * One row per social sync per platform. The Settings card derives its
 * "Connected" status from rows here, as Gmail does from sync_runs — its own
 * table because sync_runs' connector enum and count columns don't fit.
 */
export const socialSyncRuns = pgTable(
  "social_sync_runs",
  {
    id: serial("id").primaryKey(),
    platform: text("platform", { enum: SOCIAL_PLATFORMS }).notNull(),
    accountRows: integer("account_rows").notNull().default(0),
    postRows: integer("post_rows").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("social_sync_runs_created_at_idx").on(t.createdAt.desc())],
);

/* ------------------------------------------------------------------ *
 * Job applications
 *
 * A personal tracker, deliberately not tied to contacts — an application
 * is to a company, and the recruiter you know there already lives in the
 * CRM side. Documents are PDFs only, stored like social_post_media:
 * bytes in their own table so listApplications() never loads them, and
 * a replace is delete + re-insert under a new id so the serving route
 * can cache immutable.
 * ------------------------------------------------------------------ */

export const APPLICATION_DOC_KINDS = ["resume", "cover_letter"] as const;

export const applications = pgTable(
  "applications",
  {
    id: serial("id").primaryKey(),
    company: text("company").notNull(),
    role: text("role").notNull(),
    /** The day the application went in — a date, not a timestamp, because
     * that's how you think about it later ("applied June 3rd"). */
    appliedOn: date("applied_on"),
    /** Link to the job posting (or the application portal). */
    url: text("url"),
    /** Free-form notes — one running area per application, not a feed. */
    notes: text("notes").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("applications_applied_on_idx").on(t.appliedOn.desc())],
);

export const applicationDocs = pgTable(
  "application_docs",
  {
    id: serial("id").primaryKey(),
    applicationId: integer("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: APPLICATION_DOC_KINDS }).notNull(),
    /** The upload's original name, shown in the UI and on download. */
    filename: text("filename").notNull(),
    data: text("data").notNull(), // base64-encoded PDF
    byteSize: integer("byte_size").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // One resume + one cover letter per application. The upload action deletes
  // the old row before inserting, so the id changes on every replace — which
  // is what lets /api/application-docs/[id] serve with immutable caching.
  (t) => [uniqueIndex("application_docs_app_kind_uq").on(t.applicationId, t.kind)],
);

export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
export type Group = typeof groups.$inferSelect;
export type Note = typeof notes.$inferSelect;
export type Reminder = typeof reminders.$inferSelect;
export type Draft = typeof drafts.$inferSelect;
export type DraftChannel = (typeof DRAFT_CHANNELS)[number];
export type DraftSource = (typeof DRAFT_SOURCES)[number];
export type ContactChange = typeof contactChanges.$inferSelect;
export type NewContactChange = typeof contactChanges.$inferInsert;
export type Interaction = typeof interactions.$inferSelect;
export type InteractionSource = Interaction["source"];
export type InteractionPeriod = typeof interactionPeriods.$inferSelect;
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
export type SocialPost = typeof socialPosts.$inferSelect;
export type SocialPostMedia = typeof socialPostMedia.$inferSelect;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];
export type SocialPostPlatform = (typeof SOCIAL_POST_PLATFORMS)[number];
export type MetricSource = (typeof METRIC_SOURCES)[number];
export type SocialAccountMetric = typeof socialAccountMetrics.$inferSelect;
export type SocialPostMetric = typeof socialPostMetrics.$inferSelect;
export type GithubRepoStat = typeof githubRepoStats.$inferSelect;
export type SocialSyncRun = typeof socialSyncRuns.$inferSelect;
export type Application = typeof applications.$inferSelect;
export type ApplicationDoc = typeof applicationDocs.$inferSelect;
export type ApplicationDocKind = (typeof APPLICATION_DOC_KINDS)[number];
export type ContactEducation = typeof contactEducation.$inferSelect;
export type NewContactEducation = typeof contactEducation.$inferInsert;
export type ContactDoc = typeof contactDocs.$inferSelect;
