import { stripeClient } from "@better-auth/stripe/client";
import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

// Browser/React client for Better Auth. No baseURL: each regional host serves
// its own /api/auth/* on the same origin, so same-origin is correct per region.
// The plugin list mirrors the server (organization + stripe) so the client
// exposes the org + subscription methods. Pure client module — no db, safe to
// import from "use client" components.
//
// stripeClient({ subscription: true }) exposes authClient.subscription.{upgrade,
// billingPortal,...}; harmless when the SERVER plugin is unloaded (self-host /
// keyless dev) — the billing UI is hidden/degraded there so these are never
// called. Loading it unconditionally keeps this a pure, build-time-static client.
export const authClient = createAuthClient({
  plugins: [organizationClient(), stripeClient({ subscription: true })],
});

export const { signIn, signUp, signOut, useSession } = authClient;
