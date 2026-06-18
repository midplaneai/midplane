// Per-session DB scope — the engine half of Midplane's least-privilege model.
//
// The cloud proxy resolves a credential's per-agent grant (the consent-time DB
// picker for interactive agents, or the token's scope for API tokens) and sends
// it as the `X-Midplane-Scope` header. The transport parses + freezes it at MCP
// `initialize` (transport/scope-header.ts); this module applies it:
//
//   - SUBSET GATE: `scopedRegistry` exposes only the granted databases to the
//     tool surface (the `database` enum, `list_databases`, every tool's lookup).
//     A non-granted DB is simply not visible — and unreachable.
//   - READ CLAMP: a "read" grant caps that DB at read; the table_access rule
//     denies writes the policy would otherwise allow (via `ctx.scope_max_access`,
//     set per-DB by the server's `ctxFor`). `ceilingFor` maps the grant.
//
// The grant only ever NARROWS what the connection's policy already allows — it
// can't widen a denied table. One shared engine per connection is preserved: the
// clamp is per-session via ctx, not a per-session engine. Absent a scope header
// the registry is used unchanged (URL-token sessions, self-host owner-all).

import type { EngineRegistry } from "./engine-factory.ts";

export type ScopeAccess = "read" | "write";

// Frozen-for-the-session map: engine DB name → granted access. An EMPTY map is
// a deliberate, valid state ("scope active, zero DBs") — the parser returns it
// to fail closed on a malformed-but-present header. Distinct from `null`
// (header absent → no scope → full access), which is handled by the caller.
export type SessionScope = Map<string, ScopeAccess>;

// Map a grant access to the table_access rule's per-session ceiling
// (EngineContext.scope_max_access): "write" → no clamp; "read" → cap at read.
export function ceilingFor(access: ScopeAccess): "read" | "read_write" {
  return access === "write" ? "read_write" : "read";
}

// Wrap a registry so only the scoped databases are visible. The underlying
// EngineEntry (and its shared engine) is returned unchanged for in-scope DBs —
// the read clamp rides on the per-call ctx, not a per-session engine. Methods
// that aren't session-scoped (audit, setPolicy, dryRun, close) delegate.
export function scopedRegistry(
  base: EngineRegistry,
  scope: SessionScope,
): EngineRegistry {
  const inScope = (name: string): boolean => scope.has(name);
  const names = (): string[] => base.names().filter(inScope);

  return {
    get(name: string) {
      if (!inScope(name)) {
        // Mirror base.get's shape but never leak out-of-scope DB names.
        throw new Error(
          `Unknown database "${name}". Configured databases: ${names()
            .sort()
            .join(", ")}.`,
        );
      }
      return base.get(name);
    },
    has(name: string) {
      return inScope(name) && base.has(name);
    },
    names,
    count() {
      return names().length;
    },
    audit: base.audit,
    describe() {
      return base
        .describe()
        .filter((d) => inScope(d.name))
        .map((d) => {
          // Reflect the read clamp in the advertised default so list_databases
          // is honest about what THIS agent can do, not what the policy allows.
          const access = scope.get(d.name);
          const clamped =
            access === "read" && d.table_access_default === "read_write"
              ? "read"
              : d.table_access_default;
          return { ...d, table_access_default: clamped };
        });
    },
    setPolicy: (yamlText: string) => base.setPolicy(yamlText),
    dryRun: (body: unknown) => base.dryRun(body),
    close: () => base.close(),
  };
}
