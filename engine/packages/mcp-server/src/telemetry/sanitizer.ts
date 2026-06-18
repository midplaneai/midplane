// Defense-in-depth: every event is re-validated against the locked schema
// AND scanned for SQL-keyword leakage before send. The same check runs at
// the t.midplane.ai proxy on the receiver side.
//
// This is a security boundary. The forbidden-substring scan is a backstop
// against a future bug that lets a rule reason or error message leak into
// telemetry — even though the schema doesn't carry free-text fields today,
// any future addition has to clear this gate.

import {
  FORBIDDEN_PAYLOAD_SUBSTRINGS,
  StatementTypeBucket,
  TelemetryEventSchema,
  type TelemetryEvent,
} from "./schema.ts";

export type SanitizeResult =
  | { ok: true; event: TelemetryEvent; serialized: string }
  | { ok: false; reason: string };

// Strings that are legitimately allowed to equal a SQL keyword because they
// come from a locked enum (statement_type buckets). Anything outside this
// set is scanned by the forbidden-substring filter below.
const ALLOWED_KEYWORD_VALUES = new Set<string>(StatementTypeBucket.options);

export function sanitize(event: unknown): SanitizeResult {
  // Strict zod parse — unknown keys = reject (set by .strict() on every schema).
  const parsed = TelemetryEventSchema.safeParse(event);
  if (!parsed.success) {
    return { ok: false, reason: `schema_violation: ${formatIssues(parsed.error.issues)}` };
  }

  // Walk the parsed object and scan STRING VALUES only (object keys are
  // bound by the strict schema so they can't carry user content). String
  // values that match a locked enum bucket are exempted; any other string
  // value matching a SQL keyword is treated as a leak and the event is dropped.
  const violation = findForbiddenString(parsed.data);
  if (violation) {
    return { ok: false, reason: `forbidden_substring: ${violation}` };
  }

  return { ok: true, event: parsed.data, serialized: JSON.stringify(parsed.data) };
}

function findForbiddenString(node: unknown): string | null {
  if (typeof node === "string") {
    if (ALLOWED_KEYWORD_VALUES.has(node)) return null;
    for (const re of FORBIDDEN_PAYLOAD_SUBSTRINGS) {
      if (re.test(node)) return re.source;
    }
    return null;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const v = findForbiddenString(item);
      if (v) return v;
    }
    return null;
  }
  if (node && typeof node === "object") {
    for (const value of Object.values(node as Record<string, unknown>)) {
      const v = findForbiddenString(value);
      if (v) return v;
    }
    return null;
  }
  return null;
}

function formatIssues(issues: { path: (string | number | symbol)[]; message: string }[]): string {
  return issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}
