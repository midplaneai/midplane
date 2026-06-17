import { redirect } from "next/navigation";

import { AppShell } from "@/components/layout/app-shell";
import { currentCustomer } from "@/lib/customer";
import { isSelfHost } from "@/lib/self-host";

export default async function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const customer = await currentCustomer();
  if (!customer) redirect("/signup/region");

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
