// Cloud → engine admin operations.
//
// Today: hot-reload table_access on a running OSS container so policy
// edits land without killing the agent's MCP session. The engine's
// POST /admin/policy reads `tableAccess()` from a holder pointer on
// every query, so a single config swap is atomic — no half-mix
// in-flight, no need for the cloud to drain anything.
//
// Auth reuses INDEXER_TOKEN. Engine accepts raw YAML bodies in exactly
// the shape `serializePolicyToYaml` produces — no JSON envelope.

import {
  serializePolicyToYaml,
  type TableAccessPolicy,
} from "@midplane-cloud/db";

import type { ContainerRegistry } from "./spawner.ts";

export interface PushPolicyDeps {
  registry: ContainerRegistry;
  /** Shared bearer; same token the indexer presents to /audit/since.
   *  When unset, callers should not invoke this helper — the engine's
   *  /admin/policy is unauthenticated/404 in that mode and there's
   *  nothing useful to do. */
  indexerToken: string;
  /** Injected for tests. */
  fetch?: typeof fetch;
}

export type PushPolicyResult =
  // 200 — engine accepted and swapped the policy in place.
  | { delivered: true }
  // No active container OR engine returned 404 (route absent / token
  // unset on engine). PG is the durable fact; the next spawn reads it.
  | { delivered: false }
  // 400 — engine rejected the YAML/schema. Engine kept the previous
  // policy intact, so the running session is fine. Caller should NOT
  // fall back to invalidate (respawn would re-fail the same way).
  // Surface `body` to the user so they can correct the policy.
  | { rejected: { status: number; body: string } };

export async function pushPolicy(
  token: string,
  policy: TableAccessPolicy,
  deps: PushPolicyDeps,
): Promise<PushPolicyResult> {
  const active = deps.registry.getActive(token);
  if (!active) return { delivered: false };

  const fetchFn = deps.fetch ?? fetch;
  const url = `http://${active.host}:${active.port}/admin/policy`;
  const body = serializePolicyToYaml(policy);
  const res = await fetchFn(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${deps.indexerToken}`,
      "content-type": "text/yaml",
    },
    body,
  });

  if (res.status === 200) return { delivered: true };
  // Treat 404 as "engine doesn't expose the endpoint" — same shape as
  // no active container. Happens in laptop dev when INDEXER_TOKEN is
  // unset on the engine; should never happen on hosted because the
  // proxy context refuses to start without the token.
  if (res.status === 404) return { delivered: false };
  if (res.status === 400) {
    const text = await res.text().catch(() => "");
    return { rejected: { status: 400, body: text } };
  }
  // 401 / 5xx / anything else — bubble so the caller can fall back to
  // registry.invalidate. Engine state is undefined; respawn brings PG
  // and the in-memory layer back into line.
  const text = await res.text().catch(() => "");
  throw new PushPolicyError(
    `admin/policy ${res.status} from ${active.host}:${active.port}: ${text}`,
    res.status,
  );
}

export class PushPolicyError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "PushPolicyError";
  }
}
