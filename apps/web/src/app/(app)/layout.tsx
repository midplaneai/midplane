import { redirect } from "next/navigation";

import { AppShell } from "@/components/layout/app-shell";
import { currentCustomer } from "@/lib/customer";
import { getActorEmail } from "@/lib/org-context";
import { selfHostNonMemberRedirect } from "@/lib/self-host-gate";
import { isSelfHost } from "@/lib/self-host";

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
  return (
    <AppShell region={region} selfHost={selfHost}>
      {children}
    </AppShell>
  );
}
