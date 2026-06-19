import { redirect } from "next/navigation";

import { AppShell } from "@/components/layout/app-shell";
import { currentCustomer } from "@/lib/customer";
import { getActiveRole } from "@/lib/org-auth";
import { getActorEmail } from "@/lib/org-context";
import { selfHostNonMemberRedirect } from "@/lib/self-host-gate";
import { isSelfHost } from "@/lib/self-host";

// Force every authenticated route to render per-request — never at `next build`.
// This layout (and every page under it) reads the session + the regional DB:
// currentCustomer() → getOrgContext() → getAuth(), and getAuth() constructs the
// Better Auth instance with `drizzleAdapter(getDb(bootRegion()))`. At build time
// MIDPLANE_REGION is unset, so a static prerender throws "MIDPLANE_REGION must
// be eu or us" before the request-time dynamic bailout (headers()) is reached.
// These pages are per-user + per-region and were already dynamic at runtime;
// force-dynamic on the layout propagates to all children, so none are
// prerendered. Without it the production image build fails on whichever authed
// page Next prerenders first (billing, settings/sso, …).
export const dynamic = "force-dynamic";

export default async function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const customer = await currentCustomer();
  if (!customer) {
    // Self-host: a null customer for an authed user means NOT a member (signed
    // up via an invite not yet accepted, or revoked). Route them to accept a
    // still-pending invite, or to sign-in — never /signup/region, which is
    // cloud-only and bounces to /dashboard, looping the membership gate.
    if (isSelfHost()) {
      redirect(await selfHostNonMemberRedirect(await getActorEmail()));
    }
    redirect("/signup/region");
  }

  // Self-host has one region and no region routing, so the region chrome is
  // noise — pass null to hide the sidebar/mobile badge — and never bills, so
  // selfHost drops the Billing nav item too.
  const selfHost = isSelfHost();
  const region = selfHost ? null : customer.region;
  // The caller's role drives nav gating: owner sees Billing, admin sees the
  // Audit log but not Billing, a member sees only Projects. Resolved once here
  // and passed down; every gated route also enforces server-side.
  const role = (await getActiveRole())?.role ?? null;
  return (
    <AppShell region={region} selfHost={selfHost} role={role}>
      {children}
    </AppShell>
  );
}
