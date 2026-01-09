import { createAuthClient } from 'better-auth/react';
import { stripeClient } from '@better-auth/stripe/client';
import { lastLoginMethodClient } from 'better-auth/client/plugins';

export const authClient = createAuthClient({
  baseURL: process.env.NODE_ENV === 'production' ? process.env.NEXT_PUBLIC_APP_URL : 'http://localhost:3000',
  plugins: [stripeClient({ subscription: true }), lastLoginMethodClient()],
});

// Legacy export for backward compatibility - can be removed once all references are updated
export const betterauthClient = authClient;

export const { signIn, signOut, signUp, useSession } = authClient;
