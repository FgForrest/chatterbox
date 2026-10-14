CREATE TABLE "access_change_log" (
	"id" text PRIMARY KEY NOT NULL,
	"at" timestamp DEFAULT now() NOT NULL,
	"correlation_id" text NOT NULL,
	"actor_user_id" text,
	"actor_issuer" text,
	"actor_subject" text,
	"target_user_id" text,
	"target_issuer" text,
	"target_subject" text NOT NULL,
	"action" varchar(24) NOT NULL,
	"requested" jsonb NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"outcome" varchar(24) NOT NULL,
	"revocation" varchar(16) DEFAULT 'not-needed' NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "session_idp_credentials" (
	"session_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"capabilities" jsonb NOT NULL,
	"auth_time" timestamp,
	"verified_at" timestamp NOT NULL,
	"access_token" text NOT NULL,
	"access_token_expires_at" timestamp NOT NULL,
	"refresh_token" text,
	"refresh_token_expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_access_states" (
	"user_id" text PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"capabilities" jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"verified_at" timestamp NOT NULL,
	"source" varchar(16) NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "issuer" text;--> statement-breakpoint
ALTER TABLE "access_change_log" ADD CONSTRAINT "access_change_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_change_log" ADD CONSTRAINT "access_change_log_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_idp_credentials" ADD CONSTRAINT "session_idp_credentials_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_idp_credentials" ADD CONSTRAINT "session_idp_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_access_states" ADD CONSTRAINT "user_access_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_change_log_at_idx" ON "access_change_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "access_change_log_target_subject_idx" ON "access_change_log" USING btree ("target_subject","at");--> statement-breakpoint
CREATE INDEX "access_change_log_pending_idx" ON "access_change_log" USING btree ("at") WHERE "access_change_log"."revocation" = 'pending';--> statement-breakpoint
CREATE INDEX "session_idp_credentials_user_id_idx" ON "session_idp_credentials" USING btree ("user_id");