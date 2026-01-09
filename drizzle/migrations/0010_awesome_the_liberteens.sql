ALTER TABLE "account" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "session" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "subscription" ALTER COLUMN "amount" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription" ALTER COLUMN "currency" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription" ALTER COLUMN "recurringInterval" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription" ALTER COLUMN "status" SET DEFAULT 'incomplete';--> statement-breakpoint
ALTER TABLE "subscription" ALTER COLUMN "currentPeriodStart" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription" ALTER COLUMN "currentPeriodEnd" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription" ALTER COLUMN "cancelAtPeriodEnd" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription" ALTER COLUMN "startedAt" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription" ALTER COLUMN "customerId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription" ALTER COLUMN "productId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription" ALTER COLUMN "checkoutId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "email_verified" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "verification" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "verification" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "verification" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "verification" ALTER COLUMN "updated_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "plan" text NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "referenceId" text NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "stripeCustomerId" text;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "stripeSubscriptionId" text;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "periodStart" timestamp;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "periodEnd" timestamp;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "trialStart" timestamp;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "trialEnd" timestamp;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "seats" integer;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");