import { z } from "zod";

import { ACCESS_LEVELS } from "@midplane-cloud/db";
import { mintMcpUrl } from "@midplane-cloud/router";

import { createProject, isValidDatabaseName } from "@/lib/projects";
import { currentCustomer } from "@/lib/customer";
import { requireManagerRest } from "@/lib/org-auth";
import { PlanLimitError, planLimitBody, resolvePlan } from "@/lib/plan";
import { getPostHog } from "@/lib/posthog";

// POST /api/projects — JSON API (programmatic / non-browser callers).
//
// Body: { dsn: string, name?: string } — `name` is the first database's
// agent-facing alias; omit it and the alias is derived from the DSN's
// database name.
// Response: { id, mcpUrl, region }
//
// The browser paste-DSN form uses a Server Action instead, so it can redirect
// to a success page rather than render JSON. Both call createProject().
//
// PR2 of mcp_url_auth_security: the returned `mcpUrl` carries the
// default token's PLAINTEXT — this is the one-and-only chance for the
// API caller to capture it. createProject persists only the HMAC
// digest; there's no path to re-fetch the plaintext.

const Body = z.object({
  dsn: z
    .string()
    .min(8)
    .refine((s) => /^postgres(ql)?:\/\//i.test(s), {
      message: "must be a postgres:// or postgresql:// URL",
    }),
  // Agent-facing alias for the first database. Omit it and createProject
  // derives the alias from the DSN's database name. Must match the engine's
  // DB name grammar.
  name: z
    .string()
    .refine(isValidDatabaseName, {
      message: "must match ^[a-z][a-z0-9_-]{0,31}$",
    })
    .optional(),
  // Initial default access level for unlisted tables. Editable later
  // from the permission grid on the detail page. Defaults to `read`.
  default_access: z.enum(ACCESS_LEVELS).optional(),
});

export async function POST(req: Request) {
  const customer = await currentCustomer();
  if (!customer) {
    return Response.json({ error: "not signed in" }, { status: 401 });
  }
  // Creating a project is an owner/admin capability — a plain member operates
  // existing projects, it doesn't provision new ones. 403 (not 401) when the
  // caller is signed in but not a manager.
  const gate = await requireManagerRest();
  if (gate instanceof Response) return gate;
  const { userId } = gate;

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

  const entitlement = await resolvePlan();
  let id: string;
  let defaultTokenPlaintext: string | null;
  try {
    ({ id, defaultTokenPlaintext } = await createProject(
      customer,
      parsed.data.dsn,
      parsed.data.name ?? null,
      parsed.data.default_access ?? "read",
      userId,
      entitlement,
      // Programmatic callers have no browser for OAuth — mint a token so the
      // response carries a usable credential (the one-and-only chance to see it).
      true,
    ));
  } catch (err) {
    if (err instanceof PlanLimitError) {
      return Response.json(planLimitBody(err), { status: 402 });
    }
    throw err;
  }
  if (defaultTokenPlaintext === null) {
    // Unreachable (mintDefaultToken=true above) — guard for the nullable type.
    console.error("[api/projects] createProject returned no default token");
    return Response.json({ error: "internal" }, { status: 500 });
  }
  const mcpUrl = mintMcpUrl(customer.region, defaultTokenPlaintext, process.env);

  getPostHog()?.capture({
    distinctId: userId,
    event: "project_created",
    properties: {
      project_id: id,
      region: customer.region,
      default_access: parsed.data.default_access ?? "read",
      source: "api",
    },
  });

  return Response.json({ id, mcpUrl, region: customer.region }, { status: 201 });
}
