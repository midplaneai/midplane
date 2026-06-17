import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

// Browser/React client for Better Auth. No baseURL: each regional host serves
// its own /api/auth/* on the same origin, so same-origin is correct per region.
// The plugin list mirrors the server (organization) so the client exposes the
// org methods. Pure client module — no db, safe to import from "use client"
// components.
export const authClient = createAuthClient({
  plugins: [organizationClient()],
});

export const { signIn, signUp, signOut, useSession } = authClient;
