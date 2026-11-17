-- Clear the sample observations and roster so the workspace starts fresh,
-- keeping only the three teachers who will be observed.
DELETE FROM "observations";
--> statement-breakpoint
DELETE FROM "roster_entries";
--> statement-breakpoint
INSERT INTO "roster_entries" ("kind", "name", "created_at") VALUES
  ('teacher', 'L. Hawkins', now()),
  ('teacher', 'K. Yoder', now() + interval '1 millisecond'),
  ('teacher', 'M. Schaefer', now() + interval '2 milliseconds');
