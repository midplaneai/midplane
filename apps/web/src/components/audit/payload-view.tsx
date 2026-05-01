import { cn } from "@/lib/utils";

// Per-event-type structured renderer for the audit detail "Payload" card.
// The OSS audit payload is canonical JSON, but operators landing on /audit
// to investigate a specific event don't want to read JSON — they want the
// answer ("why was this denied?") in prose, with related fields labeled.
// Each event_type has a small structured view; unknown shapes fall through
// to a raw-JSON disclosure.
//
// The raw JSON is always available below the structured view (collapsed by
// default) so forensic readers and anyone investigating a payload field
// the structured view doesn't render can still get to it. This also
// guards against schema drift on the OSS side: if a new field appears,
// the structured view ignores it but it remains visible in raw JSON.

export function PayloadView({
  eventType,
  payload,
}: {
  eventType: string;
  payload: unknown;
}) {
  if (!payload || typeof payload !== "object") {
    return <RawJson payload={payload} />;
  }
  const p = payload as Record<string, unknown>;

  return (
    <div className="space-y-4" data-testid="audit-payload">
      <Structured eventType={eventType} payload={p} />
      <RawJson payload={payload} />
    </div>
  );
}

function Structured({
  eventType,
  payload,
}: {
  eventType: string;
  payload: Record<string, unknown>;
}) {
  switch (eventType) {
    case "ATTEMPTED":
      return <AttemptedView payload={payload} />;
    case "DECIDED":
      return <DecidedView payload={payload} />;
    case "EXECUTED":
      return <ExecutedView payload={payload} />;
    case "FAILED":
      return <FailedView payload={payload} />;
    case "POLICY_RELOADED":
      return <PolicyReloadedView payload={payload} />;
    default:
      // Unknown event_type — nothing structured to say. The raw JSON
      // disclosure below carries the full record.
      return null;
  }
}

// --- ATTEMPTED ---------------------------------------------------------------
//
// The detail page hoists SQL + fingerprint up to a top-of-page "Query"
// card (it walks the related events and pulls the ATTEMPTED row's
// payload), so they're visible on every event detail regardless of which
// lifecycle stage the user landed on. Rendering them again here would
// just duplicate the same code block. The raw-JSON disclosure below the
// structured view still carries the full ATTEMPTED payload for forensic
// readers.
function AttemptedView(_props: { payload: Record<string, unknown> }) {
  return null;
}

// --- DECIDED -----------------------------------------------------------------

function DecidedView({ payload }: { payload: Record<string, unknown> }) {
  const decision = stringField(payload, "decision")?.toLowerCase() ?? null;
  const reason = stringField(payload, "reason");
  const policyRule = stringField(payload, "policy_rule");
  const statementType = stringField(payload, "statement_type");
  const tables = stringArrayField(payload, "tables_touched");

  return (
    <div className="space-y-3">
      {reason && <Callout tone={decision === "deny" ? "deny" : "default"}>{reason}</Callout>}
      <Fields>
        {policyRule && <Field label="Policy rule">{policyRule}</Field>}
        {statementType && (
          <Field label="Statement">
            <span className="font-mono text-xs">{statementType}</span>
          </Field>
        )}
      </Fields>
      {tables && tables.length > 0 && (
        <Field label="Tables touched">
          <ChipList items={tables} />
        </Field>
      )}
    </div>
  );
}

// --- EXECUTED ----------------------------------------------------------------

function ExecutedView({ payload }: { payload: Record<string, unknown> }) {
  const execMs = numberField(payload, "exec_ms");
  const overheadMs = numberField(payload, "overhead_ms");
  const rowsAffected = numberField(payload, "rows_affected");

  return (
    <Fields>
      {execMs != null && (
        <Field label="Duration">{formatDuration(execMs)}</Field>
      )}
      {overheadMs != null && (
        <Field label="Midplane overhead">{formatDuration(overheadMs)}</Field>
      )}
      {rowsAffected != null && (
        <Field label="Rows affected">
          <span className="font-mono">{rowsAffected.toLocaleString()}</span>
        </Field>
      )}
    </Fields>
  );
}

// --- FAILED ------------------------------------------------------------------

function FailedView({ payload }: { payload: Record<string, unknown> }) {
  const error = stringField(payload, "error") ?? stringField(payload, "message");
  const code = stringField(payload, "code") ?? stringField(payload, "sqlstate");
  const execMs = numberField(payload, "exec_ms");
  return (
    <div className="space-y-3">
      {error && <Callout tone="deny">{error}</Callout>}
      <Fields>
        {code && (
          <Field label="Code">
            <span className="font-mono text-xs">{code}</span>
          </Field>
        )}
        {execMs != null && (
          <Field label="Duration before failure">
            {formatDuration(execMs)}
          </Field>
        )}
      </Fields>
    </div>
  );
}

// --- POLICY_RELOADED ---------------------------------------------------------

function PolicyReloadedView({
  payload,
}: {
  payload: Record<string, unknown>;
}) {
  // OSS payload shape isn't fully nailed down for hot-swap events; surface
  // any string-valued fields as labeled rows. Anything richer falls
  // through the raw-JSON disclosure.
  const entries = Object.entries(payload)
    .filter(([, v]) => typeof v === "string" || typeof v === "number")
    .slice(0, 8);
  if (entries.length === 0) return null;
  return (
    <Fields>
      {entries.map(([k, v]) => (
        <Field key={k} label={prettifyKey(k)}>
          <span className="font-mono text-xs">{String(v)}</span>
        </Field>
      ))}
    </Fields>
  );
}

// --- shared ------------------------------------------------------------------

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3">
      <dt className="text-[11px] uppercase tracking-[0.04em] text-subtle">
        {label}
      </dt>
      <dd className="text-sm text-foreground">{children}</dd>
    </div>
  );
}

function Fields({ children }: { children: React.ReactNode }) {
  return <dl className="space-y-1.5">{children}</dl>;
}

function Callout({
  tone,
  children,
}: {
  tone: "deny" | "default";
  children: React.ReactNode;
}) {
  // Left-rule + tinted background. `deny` for denials and errors so the
  // operator's eye lands on the actionable text first.
  return (
    <div
      className={cn(
        "rounded-md border-l-2 px-3.5 py-2.5 text-sm leading-relaxed",
        tone === "deny"
          ? "border-[hsl(var(--deny))] bg-[hsl(var(--deny)/0.08)] text-foreground"
          : "border-border bg-popover text-foreground",
      )}
    >
      {children}
    </div>
  );
}

function ChipList({ items }: { items: readonly string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((t) => (
        <span
          key={t}
          className="rounded-[3px] border border-border bg-secondary px-1.5 py-px font-mono text-[10px] text-foreground"
        >
          {t}
        </span>
      ))}
    </div>
  );
}

function RawJson({ payload }: { payload: unknown }) {
  const json = JSON.stringify(payload, null, 2);
  return (
    <details className="group rounded-md border border-border bg-popover">
      <summary className="cursor-pointer list-none select-none px-3.5 py-2 text-[11px] font-medium uppercase tracking-[0.04em] text-subtle transition-colors hover:text-foreground">
        <span className="mr-1 inline-block transition-transform group-open:rotate-90">
          ▸
        </span>
        Raw JSON
      </summary>
      <pre className="whitespace-pre-wrap break-all border-t border-border px-3.5 py-3 font-mono text-xs leading-relaxed text-foreground">
        {json}
      </pre>
    </details>
  );
}

// --- helpers -----------------------------------------------------------------

function stringField(
  p: Record<string, unknown>,
  key: string,
): string | null {
  const v = p[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function numberField(
  p: Record<string, unknown>,
  key: string,
): number | null {
  const v = p[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function stringArrayField(
  p: Record<string, unknown>,
  key: string,
): string[] | null {
  const v = p[key];
  if (!Array.isArray(v)) return null;
  return v.filter((x): x is string => typeof x === "string");
}

function formatDuration(ms: number): string {
  if (ms < 1) return "<1 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function prettifyKey(k: string): string {
  // policy_rule → "Policy rule"
  return k
    .replace(/_/g, " ")
    .replace(/\b./g, (c) => c.toUpperCase())
    .replace(/^./, (c) => c.toUpperCase());
}
