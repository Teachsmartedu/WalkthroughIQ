import { pgTable, text, jsonb, timestamp, primaryKey } from "drizzle-orm/pg-core";

// One row per completed walkthrough observation. The full observation record
// (scores, notes, tags, photo references…) lives in `data` so the front end can
// evolve its fields without a migration for every change.
export const observations = pgTable("observations", {
  id: text().primaryKey(),
  data: jsonb().notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// Shared roster of teacher and observer names used in the app's dropdowns.
export const rosterEntries = pgTable(
  "roster_entries",
  {
    kind: text().notNull(), // 'teacher' | 'observer'
    name: text().notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.name] })]
);
