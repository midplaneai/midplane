// PII/secret scrubbing for everything sent to PostHog. These assertions pin the
// concrete leak vectors that motivated the `before_send` hook (the plaintext DSN
// at proxy spawn, the masking salt, token peppers, session bearers) and guard
// the deliberate non-goals (don't break grouping, don't nuke analytics ids).

import { describe, expect, it } from "vitest";

import { scrubPostHogEvent } from "../src/lib/posthog-scrub.ts";

// The scrubber is typed against posthog-node's EventMessage; tests build the
// structural shape that matters (event name + properties) and cast in.
type Ev = Parameters<typeof scrubPostHogEvent>[0];
function ev(properties: Record<string, unknown>, event = "$exception"): Ev {
  return { distinctId: "user_123", event, properties } as Ev;
}
function props(result: Ev): Record<string, unknown> {
  return (result as { properties: Record<string, unknown> }).properties;
}

describe("scrubPostHogEvent — secret/DSN floor", () => {
  it("redacts a credentialed Postgres DSN inside an exception message", () => {
    const out = scrubPostHogEvent(
      ev({
        $exception_list: [
          {
            type: "Error",
            value:
              "connect failed for postgres://app:s3cr3t@db.internal:5432/prod",
          },
        ],
      }),
    );
    const value = (props(out).$exception_list as { value: string }[])[0]!
      .value;
    expect(value).not.toContain("s3cr3t");
    expect(value).not.toContain("db.internal");
    expect(value).toContain("[redacted]");
    // Surrounding prose is preserved so the trace stays legible.
    expect(value).toContain("connect failed for");
  });

  it("redacts a non-postgres credentialed URL (redis with no user)", () => {
    const out = scrubPostHogEvent(ev({ msg: "redis://:hunter2@cache:6379" }));
    expect(props(out).msg).toBe("[redacted]");
  });

  it("redacts a bare DB URL with no inline credentials (host leak)", () => {
    const out = scrubPostHogEvent(
      ev({ msg: "ECONNREFUSED postgresql://db.internal:5432/prod" }),
    );
    expect(props(out).msg as string).not.toContain("db.internal");
    expect(props(out).msg as string).toContain("[redacted]");
  });

  it("redacts values of sensitive-named keys wholesale", () => {
    const out = scrubPostHogEvent(
      ev({
        password: "p4ssw0rd",
        MIDPLANE_MASK_SALT: "deadbeef",
        token_pepper: "pep",
        connectionString: "postgres://a:b@c/d",
        api_key: "sk_live_abc123",
        nested: { masterSecret: "ms", access_key: "ak" },
      }),
    );
    const p = props(out);
    expect(p.password).toBe("[redacted]");
    expect(p.MIDPLANE_MASK_SALT).toBe("[redacted]");
    expect(p.token_pepper).toBe("[redacted]");
    expect(p.connectionString).toBe("[redacted]");
    expect(p.api_key).toBe("[redacted]");
    expect(p.nested).toEqual({ masterSecret: "[redacted]", access_key: "[redacted]" });
  });

  it("redacts a Midplane MCP token embedded in a copied URL", () => {
    const tok = `mp_live_${"a".repeat(32)}_ABC123`;
    const out = scrubPostHogEvent(
      ev({
        $exception_list: [
          { type: "Error", value: `404 on POST /mcp/${tok}/sse` },
        ],
        url: `https://app.midplane.ai/mcp/${tok}`,
      }),
    );
    const value = (props(out).$exception_list as { value: string }[])[0]!.value;
    expect(value).not.toContain(tok);
    expect(value).toContain("[redacted]");
    expect(value).toContain("/mcp/"); // path prose survives, secret doesn't
    expect(props(out).url as string).not.toContain(tok);
  });

  it("redacts an mp_test token in a non-sensitive key (value pattern, not key name)", () => {
    const tok = `mp_test_${"f".repeat(32)}_0HJKMN`;
    // `note` is not on the sensitive-key list, so a pass here proves the value
    // pattern caught the token shape — the gap the reviewer flagged.
    const out = scrubPostHogEvent(ev({ note: `minted ${tok}`, prefix: "mp_live" }, "token_created"));
    expect(props(out).note).toBe("minted [redacted]");
    expect(props(out).prefix).toBe("mp_live"); // dashboard metadata, not a secret
  });

  it("redacts JWTs and Bearer tokens in free text", () => {
    const jwt = "eyJhbGc.eyJzdWI.sIgVaTuRe";
    const out = scrubPostHogEvent(
      ev({ msg: `auth failed token=${jwt} header 'Bearer abc.def-123'` }),
    );
    const msg = props(out).msg as string;
    expect(msg).not.toContain(jwt);
    expect(msg).toContain("Bearer [redacted]");
  });

  it("walks nested arrays/objects (stack frame vars)", () => {
    const out = scrubPostHogEvent(
      ev({
        $exception_list: [
          {
            stacktrace: {
              frames: [{ vars: { dsn: "postgres://u:p@h/db", line: 42 } }],
            },
          },
        ],
      }),
    );
    const frame = (
      props(out).$exception_list as {
        stacktrace: { frames: { vars: Record<string, unknown> }[] };
      }[]
    )[0]!.stacktrace.frames[0]!;
    expect(frame.vars.dsn).toBe("[redacted]");
    expect(frame.vars.line).toBe(42); // non-sensitive sibling untouched
  });
});

describe("scrubPostHogEvent — non-goals / footguns", () => {
  it("preserves identifiers needed for grouping + attribution", () => {
    const out = scrubPostHogEvent(
      ev({ $exception_fingerprint: "abc", $exception_level: "error" }),
    );
    expect((out as { distinctId: string }).distinctId).toBe("user_123");
    expect((out as { event: string }).event).toBe("$exception");
    expect(props(out).$exception_fingerprint).toBe("abc");
  });

  it("does NOT nuke a bare `token` analytics id or `projectDatabaseId`", () => {
    const out = scrubPostHogEvent(
      ev({ token: "tok_abc123", projectDatabaseId: "pdb_42" }, "token_created"),
    );
    expect(props(out).token).toBe("tok_abc123");
    expect(props(out).projectDatabaseId).toBe("pdb_42");
  });

  it("leaves non-string scalars and unrelated prose intact", () => {
    const out = scrubPostHogEvent(
      ev({ count: 3, ok: true, note: "spawned engine for project" }, "capture"),
    );
    expect(props(out)).toEqual({
      count: 3,
      ok: true,
      note: "spawned engine for project",
    });
  });

  it("passes through null and property-less events", () => {
    expect(scrubPostHogEvent(null)).toBeNull();
    const bare = { distinctId: "u", event: "x" } as Ev;
    expect(scrubPostHogEvent(bare)).toBe(bare);
  });

  it("leaves the query_decided property set intact (no key collides with SENSITIVE_KEY)", () => {
    // The launch-analytics core event's whitelisted shape: ids, enums, and
    // counts only. Pinned so a future scrubber key-pattern addition (e.g. a
    // broader `token` match) can't silently null the query-path analytics.
    const properties = {
      decision: "deny",
      policy_rule: "table_access",
      statement_type: "SELECT",
      dialect: "postgres",
      tables_touched_count: 2,
      database: "main",
      agent_name: "claude-code",
      agent_version: "1.2.3",
      intent_source: "mcp_meta",
      audit_id: "01HXROW0000000000000000001",
      query_id: "q-1",
      mcp_token_id: "01HXTOK0000000000000000000",
      project_id: "01HXPRJ0000000000000000000",
      customer_id: "01HXCUS0000000000000000000",
      region: "eu",
    };
    const out = scrubPostHogEvent(ev({ ...properties }, "query_decided"));
    expect(props(out)).toEqual(properties);
  });
});
