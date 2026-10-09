CREATE TABLE "mailbox_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ingestion_source_id" uuid NOT NULL,
	"alias_email" text NOT NULL,
	"canonical_email" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "archived_emails" ADD COLUMN "original_user_email" text;--> statement-breakpoint
ALTER TABLE "mailbox_aliases" ADD CONSTRAINT "mailbox_aliases_ingestion_source_id_ingestion_sources_id_fk" FOREIGN KEY ("ingestion_source_id") REFERENCES "public"."ingestion_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_aliases" ADD CONSTRAINT "mailbox_aliases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_alias_source_alias_idx" ON "mailbox_aliases" USING btree ("ingestion_source_id","alias_email");--> statement-breakpoint
CREATE INDEX "mailbox_alias_source_canonical_idx" ON "mailbox_aliases" USING btree ("ingestion_source_id","canonical_email");--> statement-breakpoint
CREATE INDEX "original_user_email_source_idx" ON "archived_emails" USING btree ("ingestion_source_id","original_user_email") WHERE "archived_emails"."original_user_email" is not null;