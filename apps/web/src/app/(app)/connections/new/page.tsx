import Link from "next/link";
import { redirect } from "next/navigation";

import { ACCESS_LEVELS, type AccessLevel } from "@midplane-cloud/db/policy";

import { AccessRadio } from "@/components/access-radio";
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
                Best practice: a least-privilege role. Midplane enforces the
                access level you pick below; defense-in-depth at the DB layer
                still matters.
              </p>
            </div>
            <fieldset className="space-y-3">
              <legend className="text-sm font-medium text-foreground">
                Default agent access
              </legend>
              <p className="text-xs text-muted-foreground">
                Sets the baseline for any table the agent queries. Per-table
                overrides can be added later from the connection page.
              </p>
              <div className="space-y-2">
                <AccessRadio
                  value="read"
                  label="Read"
                  description="Agents can query any table. Writes always denied unless granted per-table. Recommended."
                  defaultChecked
                />
                <AccessRadio
                  value="deny"
                  label="Deny"
                  description="Agents have no access until you grant it explicitly. Strictest; useful when you want allowlisting from day one."
                />
                <AccessRadio
                  value="read_write"
                  label="Read + write"
                  description="Agents can read and write any table. Not recommended outside one-shot migration tokens."
                />
              </div>
            </fieldset>
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

  // Form-posted radio values are strings. Validate against the canonical
  // enum so a tampered request can't smuggle in something the spawner
  // would later refuse — and so a missing field falls back to `read`.
  const accessRaw = formData.get("default_access");
  const defaultAccess: AccessLevel =
    typeof accessRaw === "string" &&
    (ACCESS_LEVELS as readonly string[]).includes(accessRaw)
      ? (accessRaw as AccessLevel)
      : "read";

  const { id } = await createConnection(customer, dsn, name, defaultAccess);
  // Land on the dashboard with the agent-setup sheet auto-opened for this
  // new connection. The sheet strips the ?setup= param after first open so
  // a reload doesn't re-trigger.
  redirect(`/dashboard?setup=${id}`);
}
