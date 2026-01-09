import { betterAuth } from 'better-auth/minimal';
import { nextCookies } from 'better-auth/next-js';
import { lastLoginMethod } from 'better-auth/plugins';
import {
  user,
  session,
  verification,
  account,
  chat,
  message,
  extremeSearchUsage,
  messageUsage,
  subscription as subscriptionTable,
  payment,
  customInstructions,
  stream,
  lookout,
} from '@/lib/db/schema';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { db } from '@/lib/db';
import { config } from 'dotenv';
import { serverEnv } from '@/env/server';
import { stripe } from '@better-auth/stripe';
import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { invalidateUserCaches } from './performance-cache';
import { clearUserDataCache } from './user-data-server';

config({
  path: '.env.local',
});

// Utility function to safely parse dates
function safeParseDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseBooleanFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  }
  return Boolean(value);
}

// Helper function to handle Stripe subscription webhook events
async function handleStripeSubscriptionEvent(event: Stripe.Event) {
  try {
    const subscription = event.data.object as Stripe.Subscription;
    const customerId = subscription.customer as string;
    
    // Get userId from subscription metadata or customer
    let userId: string | null = null;
    
    // Try to get userId from subscription metadata first
    if (subscription.metadata?.userId) {
      userId = subscription.metadata.userId;
    } else {
      // Try to find user by Stripe customer ID
      const existingSubscription = await db.query.subscription.findFirst({
        where: eq(subscriptionTable.stripeCustomerId, customerId),
        columns: { referenceId: true },
      });
      userId = existingSubscription?.referenceId || null;
    }

    if (!userId) {
      console.warn('⚠️ No userId found for Stripe subscription event:', event.type);
      return;
    }

    // Map event types to status
    const eventTypeToStatus: Record<string, string> = {
      'customer.subscription.created': 'active',
      'customer.subscription.updated': mapStripeStatus(subscription.status),
      'customer.subscription.deleted': 'canceled',
      'customer.subscription.paused': 'paused',
      'customer.subscription.resumed': 'active',
    };

    const status = eventTypeToStatus[event.type] || subscription.status;

    // Helper to map Stripe status
    function mapStripeStatus(stripeStatus: string): string {
      switch (stripeStatus) {
        case 'active': return 'active';
        case 'canceled': return 'canceled';
        case 'past_due':
        case 'unpaid': return 'past_due';
        case 'trialing': return 'trialing';
        case 'paused': return 'paused';
        default: return stripeStatus;
      }
    }

    // Build subscription data according to Better Auth Stripe schema
    const subscriptionData = {
      id: subscription.id,
      plan: 'pro',
      referenceId: userId,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscription.id,
      status,
      periodStart: new Date((subscription as any).current_period_start * 1000),
      periodEnd: new Date((subscription as any).current_period_end * 1000),
      trialStart: subscription.trial_start ? new Date(subscription.trial_start * 1000) : null,
      trialEnd: subscription.trial_end ? new Date(subscription.trial_end * 1000) : null,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      cancelAt: subscription.cancel_at ? new Date(subscription.cancel_at * 1000) : null,
      canceledAt: subscription.canceled_at ? new Date(subscription.canceled_at * 1000) : null,
      endedAt: subscription.ended_at ? new Date(subscription.ended_at * 1000) : null,
    };

    console.log('💾 Processing Stripe webhook event:', {
      type: event.type,
      id: subscriptionData.id,
      status: subscriptionData.status,
      referenceId: subscriptionData.referenceId,
    });

    // Upsert subscription
    await db
      .insert(subscriptionTable)
      .values(subscriptionData)
      .onConflictDoUpdate({
        target: subscriptionTable.id,
        set: {
          plan: subscriptionData.plan,
          referenceId: subscriptionData.referenceId,
          status: subscriptionData.status,
          stripeCustomerId: subscriptionData.stripeCustomerId,
          stripeSubscriptionId: subscriptionData.stripeSubscriptionId,
          periodStart: subscriptionData.periodStart,
          periodEnd: subscriptionData.periodEnd,
          trialStart: subscriptionData.trialStart,
          trialEnd: subscriptionData.trialEnd,
          cancelAtPeriodEnd: subscriptionData.cancelAtPeriodEnd,
          cancelAt: subscriptionData.cancelAt,
          canceledAt: subscriptionData.canceledAt,
          endedAt: subscriptionData.endedAt,
        },
      });

    console.log('✅ Processed Stripe webhook event:', event.type, subscription.id);

    // Invalidate user caches
    if (userId) {
      invalidateUserCaches(userId);
      clearUserDataCache(userId);
      console.log('🗑️ Invalidated caches for user:', userId);
    }
  } catch (error) {
    console.error('💥 Error processing Stripe webhook event:', error);
  }
}

// Initialize Stripe client
export const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-12-15.clover',
});

export const auth = betterAuth({
  rateLimit: {
    max: 100,
    window: 60,
  },
  experimental: { joins: true },
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user,
      session,
      verification,
      account,
      chat,
      message,
      extremeSearchUsage,
      messageUsage,
      subscription: subscriptionTable,
      payment,
      customInstructions,
      stream,
      lookout,
    },
  }),
  socialProviders: {
    github: {
      clientId: serverEnv.GITHUB_CLIENT_ID,
      clientSecret: serverEnv.GITHUB_CLIENT_SECRET,
    },
    google: {
      clientId: serverEnv.GOOGLE_CLIENT_ID,
      clientSecret: serverEnv.GOOGLE_CLIENT_SECRET,
    },
    twitter: {
      clientId: serverEnv.TWITTER_CLIENT_ID,
      clientSecret: serverEnv.TWITTER_CLIENT_SECRET,
    },
    microsoft: {
      clientId: process.env.MICROSOFT_CLIENT_ID as string,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET as string,
      prompt: 'select_account', // Forces account selection
    },
  },
  plugins: [
    lastLoginMethod(),
    stripe({
      stripeClient: stripeClient,
      stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
      createCustomerOnSignUp: true,
      subscription: {
        enabled: true,
        plans: [
          {
            name: 'pro',
            priceId: process.env.STRIPE_PRO_PRICE_ID || process.env.STRIPE_PREMIUM_PRICE_ID || '',
          },
        ],
        onSubscriptionUpdate: async ({ event, subscription: sub }) => {
          try {
            // Extract Stripe subscription from event
            if (event.type.startsWith('customer.subscription.')) {
              const stripeSubscription = event.data.object as Stripe.Subscription;
              const userId = sub.referenceId; // referenceId is the userId in better-auth

              if (!userId) {
                console.warn('⚠️ No userId (referenceId) found in subscription update');
                return;
              }

              // Map Stripe subscription status to our format
              const mapStripeStatus = (stripeStatus: string): string => {
                switch (stripeStatus) {
                  case 'active':
                    return 'active';
                  case 'canceled':
                    return 'canceled';
                  case 'past_due':
                  case 'unpaid':
                    return 'past_due';
                  case 'trialing':
                    return 'trialing';
                  default:
                    return stripeStatus;
                }
              };

              // Build subscription data according to Better Auth Stripe schema
              const subscriptionData = {
                id: stripeSubscription.id,
                plan: sub.plan || 'pro', // Plan name from better-auth subscription
                referenceId: userId,
                stripeCustomerId: stripeSubscription.customer as string,
                stripeSubscriptionId: stripeSubscription.id,
                status: mapStripeStatus(stripeSubscription.status),
                periodStart: new Date((stripeSubscription as any).current_period_start * 1000),
                periodEnd: new Date((stripeSubscription as any).current_period_end * 1000),
                trialStart: stripeSubscription.trial_start ? new Date(stripeSubscription.trial_start * 1000) : null,
                trialEnd: stripeSubscription.trial_end ? new Date(stripeSubscription.trial_end * 1000) : null,
                cancelAtPeriodEnd: stripeSubscription.cancel_at_period_end,
                cancelAt: stripeSubscription.cancel_at ? new Date(stripeSubscription.cancel_at * 1000) : null,
                canceledAt: stripeSubscription.canceled_at ? new Date(stripeSubscription.canceled_at * 1000) : null,
                endedAt: stripeSubscription.ended_at ? new Date(stripeSubscription.ended_at * 1000) : null,
              };

              console.log('💾 Processing Stripe subscription update:', {
                id: subscriptionData.id,
                status: subscriptionData.status,
                referenceId: subscriptionData.referenceId,
                plan: subscriptionData.plan,
              });

              // Upsert subscription (Stripe plugin will also manage this, but we sync for legacy compatibility)
              await db
                .insert(subscriptionTable)
                .values(subscriptionData)
                .onConflictDoUpdate({
                  target: subscriptionTable.id,
                  set: {
                    plan: subscriptionData.plan,
                    referenceId: subscriptionData.referenceId,
                    status: subscriptionData.status,
                    stripeCustomerId: subscriptionData.stripeCustomerId,
                    stripeSubscriptionId: subscriptionData.stripeSubscriptionId,
                    periodStart: subscriptionData.periodStart,
                    periodEnd: subscriptionData.periodEnd,
                    trialStart: subscriptionData.trialStart,
                    trialEnd: subscriptionData.trialEnd,
                    cancelAtPeriodEnd: subscriptionData.cancelAtPeriodEnd,
                    cancelAt: subscriptionData.cancelAt,
                    canceledAt: subscriptionData.canceledAt,
                    endedAt: subscriptionData.endedAt,
                  },
                });

              console.log('✅ Upserted Stripe subscription:', stripeSubscription.id);

              // Invalidate user caches
              if (userId) {
                invalidateUserCaches(userId);
                clearUserDataCache(userId);
                console.log('🗑️ Invalidated caches for user:', userId);
              }
            }
          } catch (error) {
            console.error('💥 Error processing Stripe subscription update:', error);
          }
        },
      },
      onEvent: async (event) => {
        // Handle all Stripe webhook events
        console.log('🔔 Received Stripe webhook:', event.type);
        console.log('📦 Payload data:', JSON.stringify(event.data, null, 2));

        // Handle subscription-specific events
        if (event.type.startsWith('customer.subscription.')) {
          await handleStripeSubscriptionEvent(event);
        }
      },
    }),
    nextCookies(),
  ],
  trustedOrigins: ['http://localhost:3000', 'https://rovo.ai', 'https://www.rovo.ai'],
  allowedOrigins: ['http://localhost:3000', 'https://rovo.ai', 'https://www.rovo.ai'],
});
