ALTER TABLE "subscription" DROP CONSTRAINT "subscription_userId_user_id_fk";
--> statement-breakpoint
ALTER TABLE "dodosubscription" ALTER COLUMN "created_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "payment" ALTER COLUMN "created_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "cancelAt" timestamp;--> statement-breakpoint
ALTER TABLE "subscription" DROP COLUMN "createdAt";--> statement-breakpoint
ALTER TABLE "subscription" DROP COLUMN "modifiedAt";--> statement-breakpoint
ALTER TABLE "subscription" DROP COLUMN "amount";--> statement-breakpoint
ALTER TABLE "subscription" DROP COLUMN "currency";--> statement-breakpoint
ALTER TABLE "subscription" DROP COLUMN "recurringInterval";--> statement-breakpoint
ALTER TABLE "subscription" DROP COLUMN "currentPeriodStart";--> statement-breakpoint
ALTER TABLE "subscription" DROP COLUMN "currentPeriodEnd";--> statement-breakpoint
ALTER TABLE "subscription" DROP COLUMN "startedAt";--> statement-breakpoint
ALTER TABLE "subscription" DROP COLUMN "endsAt";--> statement-breakpoint
ALTER TABLE "subscription" DROP COLUMN "customerId";--> statement-breakpoint
ALTER TABLE "subscription" DROP COLUMN "productId";--> statement-breakpoint
ALTER TABLE "subscription" DROP COLUMN "discountId";--> statement-breakpoint
ALTER TABLE "subscription" DROP COLUMN "checkoutId";--> statement-breakpoint
ALTER TABLE "subscription" DROP COLUMN "customerCancellationReason";--> statement-breakpoint
ALTER TABLE "subscription" DROP COLUMN "customerCancellationComment";--> statement-breakpoint
ALTER TABLE "subscription" DROP COLUMN "metadata";--> statement-breakpoint
ALTER TABLE "subscription" DROP COLUMN "customFieldData";--> statement-breakpoint
ALTER TABLE "subscription" DROP COLUMN "userId";