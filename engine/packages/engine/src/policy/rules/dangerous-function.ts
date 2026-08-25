// dangerous_function rule (guardrail).
//
// Refuses a statement that invokes a Postgres function which reads or writes
// data OUTSIDE the relations the statement names — regardless of policy, like
// multi_statement and unlike the configurable dangerous_statement guards.
//
// WHY THIS EXISTS. Every other rule is RELATION-shaped: table_access replays
// per-table checks, tenant_scope checks per-scope predicates, and both key on a
// table reference the dialect resolved. A statement whose payload sits inside a
// function ARGUMENT surfaces no table reference at all, so there is nothing for
// those rules to check and nothing for the audit accumulator to record:
//
//   SELECT query_to_xml('SELECT ssn FROM secrets', false, true, '')
//   SELECT table_to_xml('secrets'::regclass, false, true, '')
//   SELECT database_to_xml(false, true, '')
//   SELECT pg_read_file('/etc/passwd')
//
// Before this rule all four were ALLOW under `table_access.default: deny` with
// every guardrail on, while the plainly-spelled `SELECT ssn FROM secrets` was
// denied — and the audit row for each read `tables_touched=[]`, so the read left
// no trace of what it touched.
//
// The XML-export family is the severe half and the reason this is ungated. Those
// functions are PostgreSQL CORE (no extension) and EXECUTE is granted to PUBLIC,
// so they need no privileged connection: they run as the connected role using
// the ordinary SELECT privilege it already has. `database_to_xml` returns every
// readable table in one statement, and on a tenant-scoped deployment
// `query_to_xml('SELECT * FROM users')` returns every tenant's rows. The
// filesystem/large-object family (pg_read_file, lo_import/lo_export, …) is the
// milder half: Postgres itself denies those to a role that is not a superuser or
// a member of pg_read_server_files / pg_write_server_files. We refuse both,
// because a deployment fronting a privileged connection is exactly the case
// Midplane exists to make safe.
//
// DENYLIST, NOT ALLOWLIST. The masking gate (dialects/postgres/mask-safety.ts)
// is deny-by-default over a vetted allowlist, which is correct THERE: masking is
// opt-in and high-assurance, so over-rejecting is an acceptable price. This rule
// is always on, so the same posture would reject ordinary analytics queries for
// any builtin nobody remembered to list. A denylist inverts the failure mode: a
// family we forgot stays allowed until we add it, which is the tradeoff an
// always-on rule has to make. The two lists are kept consistent by construction
// — every family below is drawn from the audited DELIBERATE EXCLUSIONS block at
// the end of mask-safety.ts.
//
// MATCHING IS ON THE BARE NAME, CASE-FOLDED. `pg_catalog.query_to_xml(…)` and
// `QUERY_TO_XML(…)` are the same function; qualification and case are not escape
// hatches. A user-defined `public.query_to_xml` is also refused — over-refusing a
// name someone chose to collide with a dangerous builtin is the safe direction.
// (Postgres folds unquoted identifiers to lower case at parse time; a
// quoted `"PG_READ_FILE"` is a genuinely different, non-builtin name, and
// case-folding here refuses it too. Also the safe direction.)
//
// WHAT THIS CANNOT DO. Name matching cannot see through a wrapper: a
// SECURITY DEFINER UDF whose body calls pg_read_file presents only its own name
// to the parser. That is not fixable in the AST — it needs the function's body
// or its identity resolved against pg_proc. The durable defense is to
// `REVOKE EXECUTE … FROM PUBLIC` on these families when provisioning the role
// (scripts/sample-db/provision.sql already does this for the lo_* family), which
// holds no matter how the call is spelled. This rule is the parser-side layer of
// that pair, not a replacement for it.

import type { Rule, RuleEvalContext, RuleVerdict } from "./index.ts";
import type { FunctionRef, NormalizedProgram } from "../../ir/types.ts";
import { PolicyRule } from "../../audit/types.ts";

// Why each family is here — every one reaches data outside its syntactic
// arguments. Grouped so the reason survives future edits, and so the
// agent-facing message can name the capability rather than the function.
type DangerFamily =
  | "dynamic_sql"
  | "filesystem"
  | "large_object"
  | "remote"
  | "session_config"
  | "rowtype_deref"
  | "admin";

// Executes a SQL string, or serializes a relation named by a string/regclass —
// either way it reads tables the parser never sees. CORE + PUBLIC-executable, so
// no privileged connection is needed. This is the family that bypasses
// table_access and tenant_scope outright.
const DYNAMIC_SQL = [
  "query_to_xml", "query_to_xmlschema", "query_to_xml_and_xmlschema",
  "table_to_xml", "table_to_xmlschema", "table_to_xml_and_xmlschema",
  "schema_to_xml", "schema_to_xmlschema", "schema_to_xml_and_xmlschema",
  "database_to_xml", "database_to_xmlschema", "database_to_xml_and_xmlschema",
  "cursor_to_xml", "cursor_to_xmlschema",
];

// Reads or writes server-side files. Requires role privileges Postgres enforces
// independently; refused here so a privileged connection is not a cliff edge.
const FILESYSTEM = [
  "pg_read_file", "pg_read_binary_file", "pg_stat_file",
  "pg_ls_dir", "pg_ls_logdir", "pg_ls_waldir", "pg_ls_archive_statusdir",
  "pg_ls_tmpdir", "pg_ls_replslotdir", "pg_ls_logicalmapdir",
  "pg_ls_logicalsnapdir",
];

// Large objects reach the filesystem (lo_import/lo_export) or move bulk bytes
// through the DB. lo_export is a WRITE to an arbitrary path.
const LARGE_OBJECT = [
  "lo_import", "lo_export", "lo_get", "lo_put", "lo_from_bytea",
  "loread", "lowrite", "lo_create", "lo_creat", "lo_open", "lo_unlink",
];

// Opens a connection to another server: reads data from outside this database
// entirely, and is an SSRF primitive against the network the engine sits in.
const REMOTE = [
  "dblink", "dblink_connect", "dblink_connect_u", "dblink_exec",
  "dblink_open", "dblink_fetch", "dblink_send_query", "dblink_get_result",
];

// Reads or writes session GUCs. `current_setting` can target the masking salt,
// and `set_config` can change execution context under the engine's feet.
const SESSION_CONFIG = ["current_setting", "set_config"];

// The first argument is a rowtype/table-name deref (`null::some_table`), so
// Postgres reads that table's shape from the catalog rather than the passed
// value. Called out as a REAL leak path in mask-safety.ts's exclusions.
const ROWTYPE_DEREF = [
  "json_populate_record", "jsonb_populate_record",
  "json_populate_recordset", "jsonb_populate_recordset",
  "json_to_record", "jsonb_to_record",
  "json_to_recordset", "jsonb_to_recordset",
];

// Changes server state. None of these answer a question about data.
const ADMIN = [
  "pg_terminate_backend", "pg_cancel_backend", "pg_reload_conf",
  "pg_rotate_logfile", "pg_promote", "pg_create_restore_point",
  "pg_switch_wal", "pg_drop_replication_slot",
  "pg_create_physical_replication_slot", "pg_create_logical_replication_slot",
];

function familyMap(): ReadonlyMap<string, DangerFamily> {
  const m = new Map<string, DangerFamily>();
  const add = (names: string[], family: DangerFamily) => {
    for (const n of names) m.set(n, family);
  };
  add(DYNAMIC_SQL, "dynamic_sql");
  add(FILESYSTEM, "filesystem");
  add(LARGE_OBJECT, "large_object");
  add(REMOTE, "remote");
  add(SESSION_CONFIG, "session_config");
  add(ROWTYPE_DEREF, "rowtype_deref");
  add(ADMIN, "admin");
  return m;
}

export const DANGEROUS_FUNCTIONS: ReadonlyMap<string, DangerFamily> = familyMap();

// What the agent is told it cannot do. Names the CAPABILITY, not the policy key:
// the reader is an agent that cannot edit the policy, and this rule has no key
// to flip anyway. Same reasoning as dangerous-statement's messages.
function capabilityOf(family: DangerFamily): string {
  switch (family) {
    case "dynamic_sql":
      return (
        "runs a SQL statement passed as a string, or serializes a relation " +
        "named as a string. That reads tables the policy cannot see, so it " +
        "bypasses table-access and tenant-scope rules"
      );
    case "filesystem":
      return "reads files from the database server's filesystem";
    case "large_object":
      return "reads or writes server-side files and large objects";
    case "remote":
      return "opens a connection to another database server";
    case "session_config":
      return "reads or writes session configuration, which can expose engine internals";
    case "rowtype_deref":
      return (
        "reads a table's definition from the catalog through a rowtype " +
        "argument rather than from the value passed to it"
      );
    case "admin":
      return "changes database server state";
  }
}

function denyFunction(name: string, family: DangerFamily): RuleVerdict {
  return {
    decision: "DENY",
    reason: PolicyRule.DANGEROUS_FUNCTION,
    message:
      `Midplane denied this query because it calls \`${name}\`, which ` +
      `${capabilityOf(family)}. Midplane blocks this regardless of ` +
      `table-access policy. Query the tables you need directly instead, ` +
      `naming them in the statement.`,
  };
}

/** Match key for a call: the bare name, case-folded. Qualification is ignored
 *  on purpose — `pg_catalog.pg_read_file` is `pg_read_file`. */
function matchKey(fn: FunctionRef): string {
  return fn.name.toLowerCase();
}

export function dangerousFunction(): Rule {
  return {
    name: PolicyRule.DANGEROUS_FUNCTION,
    evaluateIR(program: NormalizedProgram, rctx: RuleEvalContext): RuleVerdict {
      if (!rctx.parse.ok) return { decision: "ALLOW" }; // parse_error owns this case
      // Walk order, so the surfaced message names the first offending call —
      // matching how every other rule reports its first failure.
      for (const fn of program.functionsInvoked) {
        const family = DANGEROUS_FUNCTIONS.get(matchKey(fn));
        if (family) return denyFunction(fn.name, family);
      }
      return { decision: "ALLOW" };
    },
  };
}
