import { eq } from 'drizzle-orm';
import { subscription } from './db/schema';
import { getReadReplica, maindb } from './db';
import { auth } from './auth';
import { headers } from 'next/headers';
import {
  subscriptionCache,
  createSubscriptionKey,
  getProUserStatus,
  setProUserStatus,
} from './performance-cache';

export type SubscriptionDetails = {
  id: string;
  plan: string;
  status: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  cancelAt: Date | null;
  canceledAt: Date | null;
};

export type SubscriptionDetailsResult = {
  hasSubscription: boolean;
  subscription?: SubscriptionDetails;
  error?: string;
  errorType?: 'CANCELED' | 'EXPIRED' | 'GENERAL';
};

// Check Pro status from Stripe subscriptions only
async function getComprehensiveProStatus(
  userId: string,
): Promise<{ isProUser: boolean; source: 'stripe' | 'none' }> {
  try {
    const readDb = getReadReplica();
    // Check Stripe subscriptions
    const userSubscriptions = await readDb.select().from(subscription).where(eq(subscription.referenceId, userId));
    const activeSubscription = userSubscriptions.find((sub) => sub.status === 'active');

    if (activeSubscription) {
      console.log('🔥 Stripe subscription found for user:', userId);
      return { isProUser: true, source: 'stripe' };
    }

    return { isProUser: false, source: 'none' };
  } catch (error) {
    console.error('Error getting comprehensive pro status:', error);
    return { isProUser: false, source: 'none' };
  }
}

export async function getSubscriptionDetails(): Promise<SubscriptionDetailsResult> {
  'use server';

  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    });

    if (!session?.user?.id) {
      return { hasSubscription: false };
    }

    const readDb = getReadReplica();

    // Check cache first
    const cacheKey = createSubscriptionKey(session.user.id);
    const cached = subscriptionCache.get(cacheKey);
    if (cached) {
      // Update pro user status with comprehensive check
      const proStatus = await getComprehensiveProStatus(session.user.id);
      setProUserStatus(session.user.id, proStatus.isProUser);
      return cached;
    }

    const userSubscriptions = await readDb.select().from(subscription).where(eq(subscription.referenceId, session.user.id));

    if (!userSubscriptions.length) {
      const proStatus = await getComprehensiveProStatus(session.user.id);
      const result = { hasSubscription: false };
      subscriptionCache.set(cacheKey, result);
      setProUserStatus(session.user.id, proStatus.isProUser);
      return result;
    }

    // Get the most recent active subscription
    const activeSubscription = userSubscriptions
      .filter((sub) => sub.status === 'active')[0];

    if (!activeSubscription) {
      // Check for canceled or expired subscriptions
      const latestSubscription = userSubscriptions[0];

      if (latestSubscription) {
        const now = new Date();
        const isExpired = latestSubscription.periodEnd && new Date(latestSubscription.periodEnd) < now;
        const isCanceled = latestSubscription.status === 'canceled';

        const result = {
          hasSubscription: true,
          subscription: {
            id: latestSubscription.id,
            plan: latestSubscription.plan || 'unknown',
            status: latestSubscription.status,
            periodStart: latestSubscription.periodStart,
            periodEnd: latestSubscription.periodEnd,
            cancelAt: latestSubscription.cancelAt,
            canceledAt: latestSubscription.canceledAt,
          },
          error: isCanceled
            ? 'Subscription has been canceled'
            : isExpired
              ? 'Subscription has expired'
              : 'Subscription is not active',
          errorType: (isCanceled ? 'CANCELED' : isExpired ? 'EXPIRED' : 'GENERAL') as
            | 'CANCELED'
            | 'EXPIRED'
            | 'GENERAL',
        };
        subscriptionCache.set(cacheKey, result);
        const proStatus = await getComprehensiveProStatus(session.user.id);
        setProUserStatus(session.user.id, proStatus.isProUser);
        return result;
      }

      const fallbackResult = { hasSubscription: false };
      subscriptionCache.set(cacheKey, fallbackResult);
      const proStatus = await getComprehensiveProStatus(session.user.id);
      setProUserStatus(session.user.id, proStatus.isProUser);
      return fallbackResult;
    }

    const result = {
      hasSubscription: true,
      subscription: {
        id: activeSubscription.id,
        plan: activeSubscription.plan || 'unknown',
        status: activeSubscription.status,
        periodStart: activeSubscription.periodStart,
        periodEnd: activeSubscription.periodEnd,
        cancelAt: activeSubscription.cancelAt,
        canceledAt: activeSubscription.canceledAt,
      },
    };
    subscriptionCache.set(cacheKey, result);
    // Cache pro user status as true for active Stripe subscription
    setProUserStatus(session.user.id, true);
    return result;
  } catch (error) {
    console.error('Error fetching subscription details:', error);
    return {
      hasSubscription: false,
      error: 'Failed to load subscription details',
      errorType: 'GENERAL',
    };
  }
}

// Simple helper to check if user has an active subscription
export async function isUserSubscribed(): Promise<boolean> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    });

    if (!session?.user?.id) {
      return false;
    }

    // Use comprehensive check for Stripe subscriptions
    const proStatus = await getComprehensiveProStatus(session.user.id);
    return proStatus.isProUser;
  } catch (error) {
    console.error('Error checking user subscription status:', error);
    return false;
  }
}

// Fast pro user status check using cache
export async function isUserProCached(): Promise<boolean> {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user?.id) {
    return false;
  }

  // Try cache first
  const cached = getProUserStatus(session.user.id);
  if (cached !== null) {
    return cached;
  }

    // Fallback to comprehensive check (Stripe subscriptions)
    const proStatus = await getComprehensiveProStatus(session.user.id);
  setProUserStatus(session.user.id, proStatus.isProUser);
  return proStatus.isProUser;
}

// Helper to check if user has access to a specific product/tier
export async function hasAccessToProduct(productId: string): Promise<boolean> {
  const result = await getSubscriptionDetails();
  return (
    result.hasSubscription && result.subscription?.status === 'active' && result.subscription?.plan === productId
  );
}

// Helper to get user's current subscription status
export async function getUserSubscriptionStatus(): Promise<'active' | 'canceled' | 'expired' | 'none'> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    });

    if (!session?.user?.id) {
      return 'none';
    }

    // Check Stripe Pro status
    const proStatus = await getComprehensiveProStatus(session.user.id);

    if (proStatus.isProUser && proStatus.source === 'stripe') {
      return 'active';
    }

    // Get detailed status
    const result = await getSubscriptionDetails();

    if (!result.hasSubscription) {
      return 'none';
    }

    if (result.subscription?.status === 'active') {
      return 'active';
    }

    if (result.errorType === 'CANCELED') {
      return 'canceled';
    }

    if (result.errorType === 'EXPIRED') {
      return 'expired';
    }

    return 'none';
  } catch (error) {
    console.error('Error getting user subscription status:', error);
    return 'none';
  }
}

// Export the pro status function for UI components
export async function getProStatusWithSource(): Promise<{
  isProUser: boolean;
  source: 'stripe' | 'none';
}> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    });

    if (!session?.user?.id) {
      return { isProUser: false, source: 'none' };
    }

    const proStatus = await getComprehensiveProStatus(session.user.id);
    return proStatus;
  } catch (error) {
    console.error('Error getting pro status with source:', error);
    return { isProUser: false, source: 'none' };
  }
}
