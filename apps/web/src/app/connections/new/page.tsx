import { redirect } from "next/navigation";

import { ACCESS_LEVELS, type AccessLevel } from "@midplane-cloud/db";

import { Button } from "@/components/ui/button";
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
    <main className="container mx-auto max-w-2xl px-4 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">
        Connect Postgres
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Paste a Postgres connection string. We encrypt it with your
        region&apos;s KMS key and never persist the plaintext.
      </p>

      <form action={createAction} className="mt-8 space-y-4">
        <div className="space-y-2">
          <label htmlFor="name" className="text-sm font-medium">
            Name
          </label>
          <input
            id="name"
            name="name"
            type="text"
            maxLength={MAX_CONNECTION_NAME_LENGTH}
            placeholder="Production read-replica"
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <p className="text-xs text-muted-foreground">
            A short label to tell this connection apart from others. Optional.
          </p>
        </div>
        <div className="space-y-2">
          <label htmlFor="dsn" className="text-sm font-medium">
            DATABASE_URL
          </label>
          <input
            id="dsn"
            name="dsn"
            type="text"
            required
            placeholder="postgres://readonly_agent:pass@host:5432/db?sslmode=require"
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <p className="text-xs text-muted-foreground">
            Best practice: a least-privilege role. Midplane enforces the
            access level you pick below; defense-in-depth at the DB layer
            still matters.
          </p>
        </div>
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">Default agent access</legend>
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
    </main>
  );
}

function AccessRadio({
  value,
  label,
  description,
  defaultChecked,
}: {
  value: AccessLevel;
  label: string;
  description: string;
  defaultChecked?: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-md border bg-card p-3 hover:bg-accent">
      <input
        type="radio"
        name="default_access"
        value={value}
        defaultChecked={defaultChecked}
        className="mt-1"
      />
      <div className="space-y-0.5">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
    </label>
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
  redirect(`/connections/${id}`);
}
