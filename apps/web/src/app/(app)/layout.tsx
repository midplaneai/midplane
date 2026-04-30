import { redirect } from "next/navigation";

import { AppShell } from "@/components/layout/app-shell";
import { currentCustomer } from "@/lib/customer";

export default async function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const customer = await currentCustomer();
  if (!customer) redirect("/signup/region");

  return (
    <AppShell email={customer.email} region={customer.region}>
      {children}
    </AppShell>
  );
}
