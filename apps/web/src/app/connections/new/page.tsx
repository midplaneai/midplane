import { redirect } from "next/navigation";

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
            Best practice: a least-privilege role. Midplane enforces read-only
            by default in V1, but defense-in-depth at the DB layer matters.
          </p>
        </div>
        <Button type="submit" size="lg">
          Create connection
        </Button>
      </form>
    </main>
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
