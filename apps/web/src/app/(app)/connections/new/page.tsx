import Link from "next/link";
import { redirect } from "next/navigation";

import { Topbar, PageContainer } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { currentCustomer } from "@/lib/customer";
import {
  createConnection,
  isValidDsn,
  MAX_CONNECTION_NAME_LENGTH,
} from "@/lib/connections";

export default async function NewConnection() {
  const customer = await currentCustomer();
  if (!customer) redirect("/signup/region");

  return (
    <>
      <Topbar>
        <Link href="/dashboard">
          <b className="font-medium text-foreground">Connections</b>
        </Link>
        <span className="mx-2 text-subtle">/</span>New
      </Topbar>
      <PageContainer>
        <div className="mx-auto max-w-[760px]">
          <PageHeader
            title="Connect Postgres"
            subtitle="Paste a Postgres connection string. We encrypt it with your region's KMS key and never persist the plaintext."
          />

          <form action={createAction} className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                name="name"
                type="text"
                maxLength={MAX_CONNECTION_NAME_LENGTH}
                placeholder="Production read-replica"
              />
              <p className="text-xs text-muted-foreground">
                A short label to tell this connection apart from others.
                Optional.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="dsn">DATABASE_URL</Label>
              <Input
                id="dsn"
                name="dsn"
                type="text"
                required
                placeholder="postgres://readonly_agent:pass@host:5432/db?sslmode=require"
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                Best practice: a least-privilege role. Midplane enforces
                read-only by default in V1, but defense-in-depth at the DB
                layer matters.
              </p>
            </div>
            <Button type="submit" size="lg">
              Create connection
            </Button>
          </form>
        </div>
      </PageContainer>
    </>
  );
}

async function createAction(formData: FormData) {
  "use server";
  const customer = await currentCustomer();
  if (!customer) redirect("/signup/region");

  const dsn = formData.get("dsn");
  if (!isValidDsn(dsn)) {
    throw new Error("DSN must be a postgres:// URL");
  }
  const nameRaw = formData.get("name");
  const name = typeof nameRaw === "string" ? nameRaw : null;

  const { id } = await createConnection(customer, dsn, name);
  redirect(`/connections/${id}`);
}
