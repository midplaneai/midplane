import { z } from "zod";

import { ACCESS_LEVELS } from "@midplane-cloud/db";
import { mintMcpUrl } from "@midplane-cloud/router";

import {
  createConnection,
  MAX_CONNECTION_NAME_LENGTH,
} from "@/lib/connections";
import { currentCustomer } from "@/lib/customer";

// POST /api/connections — JSON API (programmatic / non-browser callers).
//
// Body: { dsn: string, name?: string }
// Response: { id, mcpUrl, region }
//
// The browser paste-DSN form uses a Server Action instead, so it can redirect
// to a success page rather than render JSON. Both call createConnection().

const Body = z.object({
  dsn: z
    .string()
    .min(8)
    .refine((s) => /^postgres(ql)?:\/\//i.test(s), {
      message: "must be a postgres:// or postgresql:// URL",
    }),
  name: z.string().max(MAX_CONNECTION_NAME_LENGTH).optional(),
  // Initial default access level for unlisted tables. Editable later
  // from the permission grid on the detail page. Defaults to `read`.
  default_access: z.enum(ACCESS_LEVELS).optional(),
});

export async function POST(req: Request) {
  const customer = await currentCustomer();
  if (!customer) {
    return Response.json({ error: "not signed in" }, { status: 401 });
  }

  let raw: unknown;
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    raw = await req.json();
  } else {
    const form = await req.formData();
    raw = Object.fromEntries(form.entries());
  }

  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid body", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { id, mcpToken } = await createConnection(
    customer,
    parsed.data.dsn,
    parsed.data.name ?? null,
    parsed.data.default_access ?? "read",
  );
  const mcpUrl = mintMcpUrl(customer.region, mcpToken, process.env);
  return Response.json({ id, mcpUrl, region: customer.region }, { status: 201 });
}
