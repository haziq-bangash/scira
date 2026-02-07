CREATE TABLE "document_index" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"user_id" text NOT NULL,
	"file_name" text NOT NULL,
	"file_url" text NOT NULL,
	"total_pages" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"tree_index" json,
	"page_contents" json,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_index" ADD CONSTRAINT "document_index_chat_id_chat_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chat"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_index" ADD CONSTRAINT "document_index_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_index_chatId_idx" ON "document_index" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "document_index_userId_idx" ON "document_index" USING btree ("user_id");