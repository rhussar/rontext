import {
  boolean,
  date,
  integer,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
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
    source: text("source", { enum: ["import", "manual"] })
      .notNull()
      .default("manual"),
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

export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
export type Group = typeof groups.$inferSelect;
export type Note = typeof notes.$inferSelect;
