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
    case "TOKEN_CREATED":
      return <TokenCreatedView payload={payload} />;
    case "TOKEN_REVOKED":
      return <TokenRevokedView payload={payload} />;
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

// --- TOKEN_CREATED / TOKEN_REVOKED -------------------------------------------
//
// Credential lifecycle events emitted by the cloud (tokens.ts). They carry
// no SQL — the "who" (actor / token id) lives in the Metadata card; these
// views surface the credential-specific payload fields.

function TokenCreatedView({ payload }: { payload: Record<string, unknown> }) {
  const name = stringField(payload, "token_name");
  const prefix = stringField(payload, "prefix");
  const last4 = stringField(payload, "last4");
  const expiresAt = stringField(payload, "expires_at");
  const connectionId = stringField(payload, "connection_id");
  return (
    <Fields>
      {name && <Field label="Token name">{name}</Field>}
      {(prefix || last4) && (
        <Field label="Token">
          <span className="font-mono text-xs">
            {prefix ?? "mp"}…{last4 ?? "????"}
          </span>
        </Field>
      )}
      <Field label="Expires">
        {expiresAt ? (
          <span className="font-mono text-xs">{expiresAt}</span>
        ) : (
          <span className="text-subtle">never</span>
        )}
      </Field>
      {connectionId && (
        <Field label="Connection">
          <span className="font-mono text-xs">{connectionId}</span>
        </Field>
      )}
    </Fields>
  );
}

function TokenRevokedView({ payload }: { payload: Record<string, unknown> }) {
  const reason = stringField(payload, "reason");
  const connectionId = stringField(payload, "connection_id");
  return (
    <div className="space-y-3">
      {reason && <Callout tone="deny">{reason}</Callout>}
      {connectionId && (
        <Fields>
          <Field label="Connection">
            <span className="font-mono text-xs">{connectionId}</span>
          </Field>
        </Fields>
      )}
    </div>
  );
}

// --- POLICY_RELOADED ---------------------------------------------------------
//
// OSS 0.5.0 emits a structured payload with strict-mode tenant_scope:
//   sections_changed:    which sections of the policy were swapped
//   databases_changed:   which DBs received an update (subset of all DBs)
//   tenant_scope:        { column, overrides, exempt } after the swap
//                        (null when fully disabled on that DB)
//   diffs:               per-DB before/after
//     table_access:      default.{from,to}, tables_{added,removed,changed}
//     tenant_scope:      column.{from,to},
//                        overrides_{added,removed,changed},
//                        exempt_{added,removed}
//
// Backwards-compat:
//   - Pre-0.4.0 POLICY_RELOADED rows have none of these fields. When
//     `sections_changed` is absent we fall through to the generic
//     key/value view below.
//   - 0.4.0 rows used `mappings_{added,removed,changed}` for the
//     tenant_scope diff. We render those too if present so historical
//     audit rows don't go blank after the cloud upgrades to 0.5.0
//     consumption. New writes only carry the 0.5.0 keys.
// The raw-JSON disclosure stays unchanged for forensic readers either way.

function PolicyReloadedView({
  payload,
}: {
  payload: Record<string, unknown>;
}) {
  const sectionsChanged = stringArrayField(payload, "sections_changed");
  const databasesChanged = stringArrayField(payload, "databases_changed");
  const diffs = isRecord(payload.diffs) ? payload.diffs : null;

  if (!sectionsChanged || !databasesChanged || sectionsChanged.length === 0) {
    return <LegacyPolicyReloadView payload={payload} />;
  }

  return (
    <div className="space-y-3">
      <Fields>
        <Field label="Sections changed">
          <ChipList items={sectionsChanged} />
        </Field>
        <Field label="Databases changed">
          <ChipList items={databasesChanged} />
        </Field>
      </Fields>
      {diffs && (
        <div className="space-y-3 pt-1">
          {databasesChanged.map((dbName) => {
            const dbDiff = isRecord(diffs[dbName]) ? diffs[dbName] : null;
            if (!dbDiff) return null;
            return <DbDiffView key={dbName} dbName={dbName} diff={dbDiff} />;
          })}
        </div>
      )}
    </div>
  );
}

function DbDiffView({
  dbName,
  diff,
}: {
  dbName: string;
  diff: Record<string, unknown>;
}) {
  const tableAccess = isRecord(diff.table_access) ? diff.table_access : null;
  const tenantScope = isRecord(diff.tenant_scope) ? diff.tenant_scope : null;

  return (
    <section className="rounded-md border border-border bg-popover p-3">
      <h3 className="mb-2 font-mono text-[11.5px] lowercase tracking-[0.04em] text-subtle">
        <span className="font-mono text-foreground">{dbName}</span>
      </h3>
      <div className="space-y-2.5">
        {tableAccess && <TableAccessDiff diff={tableAccess} />}
        {tenantScope && <TenantScopeDiff diff={tenantScope} />}
      </div>
    </section>
  );
}

function TableAccessDiff({ diff }: { diff: Record<string, unknown> }) {
  const def = isRecord(diff.default) ? diff.default : null;
  const added = mappingEntries(diff.tables_added);
  const removed = mappingEntries(diff.tables_removed);
  const changed = mappingEntries(diff.tables_changed);
  const empty =
    !def && added.length === 0 && removed.length === 0 && changed.length === 0;
  if (empty) return null;

  return (
    <div className="space-y-1.5">
      <h4 className="font-mono text-[10.5px] font-medium lowercase tracking-[0.04em] text-subtle">
        table_access
      </h4>
      {def && (
        <DiffRow
          tone="changed"
          label="default"
          value={
            <>
              <span className="font-mono">{String(def.from ?? "—")}</span>
              <span className="mx-1 text-subtle">→</span>
              <span className="font-mono">{String(def.to ?? "—")}</span>
            </>
          }
        />
      )}
      {added.map(([name, level]) => (
        <DiffRow
          key={`+${name}`}
          tone="added"
          label={name}
          value={<span className="font-mono">{String(level)}</span>}
        />
      ))}
      {removed.map(([name, level]) => (
        <DiffRow
          key={`-${name}`}
          tone="removed"
          label={name}
          value={<span className="font-mono">{String(level)}</span>}
        />
      ))}
      {changed.map(([name, fromTo]) => (
        <DiffRow
          key={`~${name}`}
          tone="changed"
          label={name}
          value={renderFromTo(fromTo)}
        />
      ))}
    </div>
  );
}

function TenantScopeDiff({ diff }: { diff: Record<string, unknown> }) {
  const column = isRecord(diff.column) ? diff.column : null;
  // Prefer the 0.5.0 keys; fall back to 0.4.0 `mappings_*` so old audit
  // rows still render. New OSS writes only carry the 0.5.0 keys.
  const overridesAdded =
    mappingEntries(diff.overrides_added).length > 0
      ? mappingEntries(diff.overrides_added)
      : mappingEntries(diff.mappings_added);
  const overridesRemoved =
    mappingEntries(diff.overrides_removed).length > 0
      ? mappingEntries(diff.overrides_removed)
      : mappingEntries(diff.mappings_removed);
  const overridesChanged =
    mappingEntries(diff.overrides_changed).length > 0
      ? mappingEntries(diff.overrides_changed)
      : mappingEntries(diff.mappings_changed);
  const exemptAdded = stringList(diff.exempt_added);
  const exemptRemoved = stringList(diff.exempt_removed);

  const empty =
    !column &&
    overridesAdded.length === 0 &&
    overridesRemoved.length === 0 &&
    overridesChanged.length === 0 &&
    exemptAdded.length === 0 &&
    exemptRemoved.length === 0;
  if (empty) return null;

  return (
    <div className="space-y-1.5">
      <h4 className="font-mono text-[10.5px] font-medium lowercase tracking-[0.04em] text-subtle">
        tenant_scope
      </h4>
      {column && (
        <DiffRow
          tone="changed"
          label="default column"
          value={
            <>
              <span className="font-mono">
                {column.from == null ? "(unset)" : String(column.from)}
              </span>
              <span className="mx-1 text-subtle">→</span>
              <span className="font-mono">
                {column.to == null ? "(unset)" : String(column.to)}
              </span>
            </>
          }
        />
      )}
      {overridesAdded.map(([table, col]) => (
        <DiffRow
          key={`+${table}`}
          tone="added"
          label={table}
          value={<span className="font-mono">override → {String(col)}</span>}
        />
      ))}
      {overridesRemoved.map(([table, col]) => (
        <DiffRow
          key={`-${table}`}
          tone="removed"
          label={table}
          value={<span className="font-mono">override → {String(col)}</span>}
        />
      ))}
      {exemptAdded.map((table) => (
        <DiffRow
          key={`+e${table}`}
          tone="added"
          label={table}
          value={<span className="font-mono text-subtle">exempt</span>}
        />
      ))}
      {exemptRemoved.map((table) => (
        <DiffRow
          key={`-e${table}`}
          tone="removed"
          label={table}
          value={<span className="font-mono text-subtle">exempt</span>}
        />
      ))}
      {overridesChanged.map(([table, fromTo]) => (
        <DiffRow
          key={`~${table}`}
          tone="changed"
          label={table}
          value={renderFromTo(fromTo)}
        />
      ))}
    </div>
  );
}

function stringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0);
}

function DiffRow({
  tone,
  label,
  value,
}: {
  tone: "added" | "removed" | "changed";
  label: string;
  value: React.ReactNode;
}) {
  // Semantic tones: added → allow, removed → deny, changed → warn. Pulls
  // from the shared token vocabulary; the page never reaches for raw
  // greens/reds.
  const toneClasses: Record<typeof tone, string> = {
    added:
      "border-[hsl(var(--allow))] bg-[hsl(var(--allow)/0.08)] text-foreground",
    removed:
      "border-[hsl(var(--deny))] bg-[hsl(var(--deny)/0.08)] text-foreground",
    changed:
      "border-[hsl(var(--warn))] bg-[hsl(var(--warn)/0.08)] text-foreground",
  };
  const sigil: Record<typeof tone, string> = {
    added: "+",
    removed: "−",
    changed: "~",
  };
  return (
    <div
      className={cn(
        "grid grid-cols-[14px_140px_1fr] items-baseline gap-2 rounded-[3px] border-l-2 px-2 py-1 text-xs",
        toneClasses[tone],
      )}
    >
      <span className="font-mono text-subtle">{sigil[tone]}</span>
      <span className="truncate font-mono text-foreground">{label}</span>
      <span className="text-foreground">{value}</span>
    </div>
  );
}

function renderFromTo(fromTo: unknown): React.ReactNode {
  if (!isRecord(fromTo)) {
    return <span className="font-mono">{String(fromTo)}</span>;
  }
  return (
    <>
      <span className="font-mono">{String(fromTo.from ?? "—")}</span>
      <span className="mx-1 text-subtle">→</span>
      <span className="font-mono">{String(fromTo.to ?? "—")}</span>
    </>
  );
}

function LegacyPolicyReloadView({
  payload,
}: {
  payload: Record<string, unknown>;
}) {
  // Pre-0.4.0 payload shape: no sections_changed / diffs. Surface any
  // string- or number-valued top-level fields as labeled rows so the
  // pane isn't empty for old rows.
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function mappingEntries(v: unknown): Array<[string, unknown]> {
  if (!isRecord(v)) return [];
  return Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
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
      <dt className="font-mono text-[11.5px] lowercase tracking-[0.04em] text-subtle">
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
      <summary className="cursor-pointer list-none select-none px-3.5 py-2 font-mono text-[11.5px] font-medium lowercase tracking-[0.04em] text-subtle transition-colors hover:text-foreground">
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
