/** Whether THIS build has Google OAuth credentials configured. Both the server
 *  auth config (lib/auth.ts socialProviders) and the sign-in/up UI gate on this,
 *  so a build WITHOUT creds — self-host, keyless dev — never wires the provider
 *  and never renders a "Continue with Google" button that couldn't complete the
 *  flow. Self-host gets Google only by setting both env vars explicitly.
 *
 *  Server-only: a NEXT_PUBLIC_ prefix isn't used (the secret must never reach the
 *  client), so the value is read in server components / the auth config and the
 *  boolean is passed down to client components as a prop. */
export function googleAuthEnabled(): boolean {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
  );
}
