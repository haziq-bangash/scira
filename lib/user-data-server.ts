import 'server-only';

import { eq, and, desc } from 'drizzle-orm';
import { subscription, user } from './db/schema';
import { getReadReplica } from './db';
import { auth } from './auth';
import { headers } from 'next/headers';
import { getCustomInstructionsByUserId, getUserPreferencesByUserId } from './db/queries';
import type { CustomInstructions, UserPreferences } from './db/schema';

// Single comprehensive user data type
export type ComprehensiveUserData = {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
  image: string | null;
  stripeCustomerId: string | null;
  createdAt: Date;
  updatedAt: Date;
  isProUser: boolean;
  subscriptionStatus: 'active' | 'canceled' | 'expired' | 'none';
  stripeSubscription?: {
    id: string;
    plan: string;
    status: string;
    periodStart: Date;
    periodEnd: Date;
    cancelAtPeriodEnd: boolean;
    cancelAt: Date | null;
    canceledAt: Date | null;
    endedAt: Date | null;
  };
};

// Lightweight user auth type for fast checks
export type LightweightUserAuth = {
  userId: string;
  email: string;
  isProUser: boolean;
};

const userDataCache = new Map<string, { data: ComprehensiveUserData; expiresAt: number }>();
const lightweightAuthCache = new Map<string, { data: LightweightUserAuth; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const LIGHTWEIGHT_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes - shorter for lightweight checks

// Custom instructions cache (per-user)
const customInstructionsCache = new Map<
  string,
  {
    instructions: CustomInstructions | null;
    timestamp: number;
    ttl: number;
  }
>();
const CUSTOM_INSTRUCTIONS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// User preferences cache (per-user)
const userPreferencesCache = new Map<
  string,
  {
    preferences: UserPreferences | null;
    timestamp: number;
    ttl: number;
  }
>();
const USER_PREFERENCES_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCachedUserData(userId: string): ComprehensiveUserData | null {
  const cached = userDataCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }
  if (cached) {
    userDataCache.delete(userId);
  }
  return null;
}

function setCachedUserData(userId: string, data: ComprehensiveUserData): void {
  userDataCache.set(userId, {
    data,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

export function clearUserDataCache(userId: string): void {
  userDataCache.delete(userId);
  // Also clear lightweight auth cache to avoid stale pro status
  lightweightAuthCache.delete(userId);
  // Clear any per-user custom instructions cache
  customInstructionsCache.delete(userId);
  // Clear any per-user preferences cache
  userPreferencesCache.delete(userId);
}

export function clearAllUserDataCache(): void {
  userDataCache.clear();
  lightweightAuthCache.clear();
  customInstructionsCache.clear();
  userPreferencesCache.clear();
}

function getCachedLightweightAuth(userId: string): LightweightUserAuth | null {
  const cached = lightweightAuthCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }
  if (cached) {
    lightweightAuthCache.delete(userId);
  }
  return null;
}

function setCachedLightweightAuth(userId: string, data: LightweightUserAuth): void {
  lightweightAuthCache.set(userId, {
    data,
    expiresAt: Date.now() + LIGHTWEIGHT_CACHE_TTL_MS,
  });
}

/**
 * Get custom instructions for a user with in-memory caching.
 * Falls back to DB via getCustomInstructionsByUserId when cache miss/expired.
 */
export async function getCachedCustomInstructionsByUserId(
  userId: string,
  options?: { ttlMs?: number },
): Promise<CustomInstructions | null> {
  const ttlMs = options?.ttlMs ?? CUSTOM_INSTRUCTIONS_CACHE_TTL_MS;
  const cached = customInstructionsCache.get(userId);
  if (cached && Date.now() - cached.timestamp < cached.ttl) {
    return cached.instructions;
  }

  const instructions = await getCustomInstructionsByUserId({ userId });
  customInstructionsCache.set(userId, {
    instructions: instructions ?? null,
    timestamp: Date.now(),
    ttl: ttlMs,
  });
  return instructions ?? null;
}

export function clearCustomInstructionsCache(userId?: string): void {
  if (userId) {
    customInstructionsCache.delete(userId);
  } else {
    customInstructionsCache.clear();
  }
}

/**
 * Get user preferences for a user with in-memory caching.
 * Falls back to DB via getUserPreferencesByUserId when cache miss/expired.
 */
export async function getCachedUserPreferencesByUserId(
  userId: string,
  options?: { ttlMs?: number },
): Promise<UserPreferences | null> {
  const ttlMs = options?.ttlMs ?? USER_PREFERENCES_CACHE_TTL_MS;
  const cached = userPreferencesCache.get(userId);
  if (cached && Date.now() - cached.timestamp < cached.ttl) {
    return cached.preferences;
  }

  const preferences = await getUserPreferencesByUserId({ userId });
  userPreferencesCache.set(userId, {
    preferences: preferences ?? null,
    timestamp: Date.now(),
    ttl: ttlMs,
  });
  return preferences ?? null;
}

export function clearUserPreferencesCache(userId?: string): void {
  if (userId) {
    userPreferencesCache.delete(userId);
  } else {
    userPreferencesCache.clear();
  }
}

/**
 * Lightweight authentication check that only fetches minimal user data.
 * This is much faster than getComprehensiveUserData() and should be used
 * for early auth checks before fetching full user details.
 *
 * @returns Lightweight user auth data or null if not authenticated
 */
export async function getLightweightUserAuth(): Promise<LightweightUserAuth | null> {
  try {
    const session = await auth.api.getSession({
      headers: await headers(),
    });

    if (!session?.user?.id) {
      return null;
    }

    const userId = session.user.id;

    // Check lightweight cache first
    const cached = getCachedLightweightAuth(userId);
    if (cached) {
      return cached;
    }

    // Check if full user data is cached (reuse it if available)
    const fullCached = getCachedUserData(userId);
    if (fullCached) {
      const lightweightData: LightweightUserAuth = {
        userId: fullCached.id,
        email: fullCached.email,
        isProUser: fullCached.isProUser,
      };
      setCachedLightweightAuth(userId, lightweightData);
      return lightweightData;
    }

    const readDb = getReadReplica();

    // Optimized query: Use JOIN to fetch user + subscription status in a single query
    const result = await readDb
      .select({
        userId: user.id,
        email: user.email,
        subscriptionStatus: subscription.status,
        subscriptionEnd: subscription.periodEnd,
      })
      .from(user)
      .leftJoin(subscription, eq(subscription.referenceId, user.id))
      .where(eq(user.id, userId));

    if (!result || result.length === 0) {
      return null;
    }

    // Check for active Stripe subscription
    const hasActiveStripeSub = result.some((row) => row.subscriptionStatus === 'active');

    const lightweightData: LightweightUserAuth = {
      userId: result[0].userId,
      email: result[0].email,
      isProUser: hasActiveStripeSub,
    };

    // Cache the result
    setCachedLightweightAuth(userId, lightweightData);

    return lightweightData;
  } catch (error) {
    console.error('Error in lightweight auth check:', error);
    return null;
  }
}

export async function getComprehensiveUserData(): Promise<ComprehensiveUserData | null> {
  try {
    // Get session once
    const session = await auth.api.getSession({
      headers: await headers(),
    });

    if (!session?.user?.id) {
      return null;
    }

    const userId = session.user.id;

    // Check cache first
    const cached = getCachedUserData(userId);
    if (cached) {
      return cached;
    }

    // OPTIMIZED: Use JOIN query to reduce DB round trips
    // Fetch user + subscriptions in a single query
    const readDb = getReadReplica();

    const userWithSubscriptions = await readDb
      .select({
        // User fields
        userId: user.id,
        email: user.email,
        emailVerified: user.emailVerified,
        name: user.name,
        image: user.image,
        stripeCustomerId: user.stripeCustomerId,
        userCreatedAt: user.createdAt,
        userUpdatedAt: user.updatedAt,
        // Subscription fields (will be null if no subscription)
        subscriptionId: subscription.id,
        subscriptionPlan: subscription.plan,
        subscriptionStatus: subscription.status,
        subscriptionPeriodStart: subscription.periodStart,
        subscriptionPeriodEnd: subscription.periodEnd,
        subscriptionCancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        subscriptionCancelAt: subscription.cancelAt,
        subscriptionCanceledAt: subscription.canceledAt,
        subscriptionEndedAt: subscription.endedAt,
      })
      .from(user)
      .leftJoin(subscription, eq(subscription.referenceId, user.id))
      .where(eq(user.id, userId));

    if (!userWithSubscriptions || userWithSubscriptions.length === 0) {
      return null;
    }

    const userData = userWithSubscriptions[0];

    // Process Stripe subscriptions from the joined data
    const stripeSubscriptions = userWithSubscriptions
      .filter((row) => row.subscriptionId !== null)
      .map((row) => ({
        id: row.subscriptionId!,
        plan: row.subscriptionPlan!,
        status: row.subscriptionStatus!,
        periodStart: row.subscriptionPeriodStart!,
        periodEnd: row.subscriptionPeriodEnd!,
        cancelAtPeriodEnd: row.subscriptionCancelAtPeriodEnd ?? false,
        cancelAt: row.subscriptionCancelAt,
        canceledAt: row.subscriptionCanceledAt,
        endedAt: row.subscriptionEndedAt,
      }));

    // Get active Stripe subscription (sort by period end to get the most current one)
    const activeStripeSubscription = stripeSubscriptions
      .filter((sub) => sub.status === 'active')
      .sort((a, b) => new Date(b.periodEnd).getTime() - new Date(a.periodEnd).getTime())[0];

    // Determine Pro status
    const isProUser = Boolean(activeStripeSubscription);
    let subscriptionStatus: 'active' | 'canceled' | 'expired' | 'none' = 'none';

    if (activeStripeSubscription) {
      subscriptionStatus = 'active';
    } else if (stripeSubscriptions.length > 0) {
      // Check for expired/canceled Stripe subscriptions
      const latestStripeSubscription = stripeSubscriptions.sort(
        (a, b) => new Date(b.periodEnd).getTime() - new Date(a.periodEnd).getTime(),
      )[0];

      const now = new Date();
      const isExpired = new Date(latestStripeSubscription.periodEnd) < now;
      const isCanceled = latestStripeSubscription.status === 'canceled';

      if (isCanceled) {
        subscriptionStatus = 'canceled';
      } else if (isExpired) {
        subscriptionStatus = 'expired';
      }
    }

    // Build comprehensive user data
    const comprehensiveData: ComprehensiveUserData = {
      id: userData.userId,
      email: userData.email,
      emailVerified: userData.emailVerified,
      name: userData.name || userData.email.split('@')[0], // Fallback to email prefix if name is null
      image: userData.image,
      stripeCustomerId: userData.stripeCustomerId,
      createdAt: userData.userCreatedAt,
      updatedAt: userData.userUpdatedAt,
      isProUser,
      subscriptionStatus,
    };

    // Add Stripe subscription details if exists
    if (activeStripeSubscription) {
      comprehensiveData.stripeSubscription = {
        id: activeStripeSubscription.id,
        plan: activeStripeSubscription.plan,
        status: activeStripeSubscription.status,
        periodStart: activeStripeSubscription.periodStart,
        periodEnd: activeStripeSubscription.periodEnd,
        cancelAtPeriodEnd: activeStripeSubscription.cancelAtPeriodEnd,
        cancelAt: activeStripeSubscription.cancelAt,
        canceledAt: activeStripeSubscription.canceledAt,
        endedAt: activeStripeSubscription.endedAt,
      };
    }

    // Cache the result
    setCachedUserData(userId, comprehensiveData);

    return comprehensiveData;
  } catch (error) {
    console.error('Error getting comprehensive user data:', error);
    return null;
  }
}

// Helper functions for backward compatibility and specific use cases
export async function isUserPro(): Promise<boolean> {
  const userData = await getComprehensiveUserData();
  return userData?.isProUser || false;
}

export async function getUserSubscriptionStatus(): Promise<'active' | 'canceled' | 'expired' | 'none'> {
  const userData = await getComprehensiveUserData();
  return userData?.subscriptionStatus || 'none';
}
