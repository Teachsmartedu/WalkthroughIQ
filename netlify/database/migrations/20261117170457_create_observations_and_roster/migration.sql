CREATE TABLE "observations" (
	"id" text PRIMARY KEY,
	"data" jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roster_entries" (
	"kind" text,
	"name" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roster_entries_pkey" PRIMARY KEY("kind","name")
);
