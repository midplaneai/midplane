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
  // noise — pass null to hide the sidebar/mobile badge.
  const region = isSelfHost() ? null : customer.region;
  return <AppShell region={region}>{children}</AppShell>;
}
