// Shared terminal rendering for the CLI's human-facing output.
//
// One convention everywhere (the grep/ls `--color=auto` model): pretty —
// one aligned, colored line per event — when stdout is a TTY; JSON lines
// when piped. Both are overridable: `--json` forces machine lines in a
// terminal, `--pretty` forces human lines into a pipe (e.g. `| less -R`).
// Layout (pretty) and color are separate decisions: NO_COLOR
// (https://no-color.org) strips escape codes but keeps the human layout,
// so `NO_COLOR=1 midplane audit denies` is still readable prose.
//
// Pure string-building, no deps — the renderer must never be a reason the
// data plane's dependency tree grows.

// Flag values come from the CLIs' hand-rolled parsers, which represent
// booleans as the strings "true"/"false".
export interface RenderFlags {
  json?: string;
  pretty?: string;
}

export function prettyMode(
  flags: RenderFlags,
  stream: NodeJS.WriteStream = process.stdout,
): boolean {
  if (flags.json === "true") return false;
  if (flags.pretty === "true") return true;
  return stream.isTTY === true;
}

export interface Palette {
  red: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  cyan: (s: string) => string;
  dim: (s: string) => string;
  bold: (s: string) => string;
}

const IDENTITY = (s: string) => s;

export function palette(enabled: boolean): Palette {
  if (!enabled) {
    return {
      red: IDENTITY,
      green: IDENTITY,
      yellow: IDENTITY,
      cyan: IDENTITY,
      dim: IDENTITY,
      bold: IDENTITY,
    };
  }
  const wrap = (open: string, close: string) => (s: string) =>
    `\x1b[${open}m${s}\x1b[${close}m`;
  return {
    red: wrap("31", "39"),
    green: wrap("32", "39"),
    yellow: wrap("33", "39"),
    cyan: wrap("36", "39"),
    dim: wrap("2", "22"),
    bold: wrap("1", "22"),
  };
}

// Color belongs to pretty mode; NO_COLOR vetoes escape codes without
// vetoing the layout.
export function paletteFor(pretty: boolean): Palette {
  return palette(pretty && !process.env.NO_COLOR);
}

// Audit payloads carry ATTACKER-CONTROLLED text (sql_raw is whatever the
// agent sent; result cells are whatever the database holds). Echoing that
// into a terminal verbatim is an escape-sequence injection vector — ESC/CSI/
// OSC bytes inside a SQL comment would execute on the operator's terminal
// the moment they run `audit denies`. Strip every control byte except \t and
// \n (C0 minus those two, DEL, and the C1 range — which is where CSI/OSC
// live when they arrive as codepoints).
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export function stripControl(s: string): string {
  return s.replace(CONTROL_CHARS, "");
}

// Collapse a SQL string (or any multi-line text) to one display line.
// The audit log stores up to 1 MiB of sql_raw — a renderer that echoes
// that into a terminal line is an attack on the reader, so truncate.
export function oneLine(s: string, max = 120): string {
  const collapsed = stripControl(s).replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 1) + "…";
}

// "2026-06-11T09:15:03Z" — full ISO minus milliseconds. UTC marker kept so
// a pasted line is unambiguous (audit `ts` is epoch ms, always UTC).
export function fmtTs(ts: number): string {
  return new Date(ts).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// The parsed-row shape shared by every audit subcommand (rowToJson's
// output): DB columns plus the payload already JSON.parse'd. Declared
// structurally here so render.ts doesn't import bun:sqlite types.
export interface AuditRowView {
  id: string;
  query_id: string;
  tenant_id: string;
  database: string;
  agent_name: string | null;
  agent_version: string | null;
  agent_intent: string | null;
  mcp_token_id: string | null;
  ts: number;
  event_type: string;
  // Payload shape varies by event_type; rendering only reads a few keys.
  payload: Record<string, unknown>;
}

// One audit event as one terminal line:
//   <ts> <TAG> <summary>  <dim meta>
// TAG is padded to a fixed width so a stream of mixed events stays
// column-aligned. The trailing meta always carries qid=<query_id> so any
// line can be followed up with `midplane audit show <query_id>`.
export function renderEventLine(r: AuditRowView, p: Palette): string {
  const { tag, summary } = eventTagAndSummary(r, p);
  const meta: string[] = [];
  if (r.agent_name) {
    meta.push(`agent=${r.agent_name}${r.agent_version ? `@${r.agent_version}` : ""}`);
  }
  // The synthetic single-DB name is noise; show `db=` only when it means something.
  if (r.database !== "__default__") meta.push(`db=${r.database}`);
  if (r.tenant_id !== "__self_host__") meta.push(`tenant=${r.tenant_id}`);
  meta.push(`qid=${r.query_id}`);
  return `${p.dim(fmtTs(r.ts))} ${tag} ${summary}  ${p.dim(meta.join(" "))}`;
}

const TAG_WIDTH = 7; // len("ALLOWED") — widest tag below

function eventTagAndSummary(
  r: AuditRowView,
  p: Palette,
): { tag: string; summary: string } {
  const pl = r.payload;
  switch (r.event_type) {
    case "ATTEMPTED": {
      const sql = typeof pl.sql_raw === "string" ? oneLine(pl.sql_raw, 100) : "";
      const intent =
        typeof r.agent_intent === "string" && r.agent_intent.length > 0
          ? ` ${p.dim(`— ${oneLine(r.agent_intent, 60)}`)}`
          : "";
      return { tag: p.dim("ATTEMPT".padEnd(TAG_WIDTH)), summary: sql + intent };
    }
    case "DECIDED": {
      if (pl.decision === "ALLOW") {
        const tables = Array.isArray(pl.tables_touched) && pl.tables_touched.length > 0
          ? ` tables=${(pl.tables_touched as string[]).join(",")}`
          : "";
        return {
          tag: p.green("ALLOWED".padEnd(TAG_WIDTH)),
          summary: `${pl.statement_type ?? "UNKNOWN"}${tables}`,
        };
      }
      const reason =
        typeof pl.reason === "string" ? ` ${oneLine(pl.reason, 90)}` : "";
      return {
        tag: p.red("DENIED".padEnd(TAG_WIDTH)),
        summary: `${p.bold(String(pl.policy_rule ?? "unknown"))}${reason}`,
      };
    }
    case "EXECUTED": {
      const rows =
        pl.rows_returned !== undefined
          ? `${pl.rows_returned} rows`
          : pl.rows_affected !== undefined
            ? `${pl.rows_affected} affected`
            : "";
      return {
        tag: p.dim("OK".padEnd(TAG_WIDTH)),
        summary: p.dim(`${pl.exec_ms ?? "?"}ms ${rows}`.trim()),
      };
    }
    case "FAILED":
      return {
        tag: p.red("FAILED".padEnd(TAG_WIDTH)),
        summary: `${pl.error_class ?? "?"} ${oneLine(String(pl.error_message ?? ""), 90)}`,
      };
    case "POLICY_RELOADED":
      return {
        tag: p.yellow("POLICY".padEnd(TAG_WIDTH)),
        summary: `policy reloaded (${pl.source ?? "unknown"})`,
      };
    default:
      // Future event types render generically rather than crashing a tail.
      return { tag: r.event_type.padEnd(TAG_WIDTH), summary: "" };
  }
}

// Small aligned table for query rows. Column set comes from the first row
// (Postgres result rows share one shape); cells are stringified, truncated
// at CELL_MAX, padded. Returns lines, no trailing newline — callers own
// stream writes.
const CELL_MAX = 40;

export function renderRowsTable(
  rows: Array<Record<string, unknown>>,
  p: Palette,
): string[] {
  if (rows.length === 0) return [p.dim("(0 rows)")];
  const cols = Object.keys(rows[0]!);
  const cells = rows.map((r) =>
    cols.map((c) => {
      const v = (r as Record<string, unknown>)[c];
      const s =
        v === null || v === undefined
          ? "NULL"
          : typeof v === "object"
            ? JSON.stringify(v)
            : String(v);
      return oneLine(s, CELL_MAX);
    }),
  );
  const widths = cols.map((c, i) =>
    Math.max(c.length, ...cells.map((row) => row[i]!.length)),
  );
  const lines: string[] = [];
  lines.push(p.bold(cols.map((c, i) => c.padEnd(widths[i]!)).join("  ")));
  lines.push(p.dim(widths.map((w) => "─".repeat(w)).join("  ")));
  for (const row of cells) {
    lines.push(row.map((cell, i) => cell.padEnd(widths[i]!)).join("  "));
  }
  return lines;
}
