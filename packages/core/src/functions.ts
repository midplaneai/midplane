// Function and operator lists. Two different postures, on purpose:
//
// DANGEROUS_FUNCTIONS is an always-on DENYLIST of builtins that reach data
// outside their arguments. `query_to_xml('SELECT ssn FROM secrets')` names no
// table the policy can check, so table access alone can't see it. A denylist,
// because an allowlist on every statement would refuse ordinary analytics for
// any builtin nobody listed. Matching is on the bare name, case-folded:
// qualification and case are not escape hatches. Name matching cannot see
// through a SECURITY DEFINER wrapper; revoking EXECUTE from PUBLIC on these
// families when provisioning the role is the durable defense.
//
// MASK_SAFE_* is a deny-by-default ALLOWLIST that applies whenever a database
// has masks. Masks are applied at the source relation, so a function's
// arguments are already masked; a function is safe iff everything it can
// observe comes from its arguments plus non-secret session context. Anything
// that reads data another way (dynamic SQL, files, the salt setting, a
// user-defined function) could return raw values, so it is refused.

type DangerFamily =
  | "dynamic_sql"
  | "filesystem"
  | "large_object"
  | "remote"
  | "session_config"
  | "rowtype_deref"
  | "sequence_write"
  | "admin";

// biome-ignore format: grouped by family for review
const FAMILIES: Record<DangerFamily, readonly string[]> = {
  // Runs a SQL string or serializes a relation named by a string. Core and
  // executable by PUBLIC, so it needs no privileged role.
  dynamic_sql: [
    "query_to_xml", "query_to_xmlschema", "query_to_xml_and_xmlschema",
    "table_to_xml", "table_to_xmlschema", "table_to_xml_and_xmlschema",
    "schema_to_xml", "schema_to_xmlschema", "schema_to_xml_and_xmlschema",
    "database_to_xml", "database_to_xmlschema", "database_to_xml_and_xmlschema",
    "cursor_to_xml", "cursor_to_xmlschema",
  ],
  filesystem: [
    "pg_read_file", "pg_read_binary_file", "pg_stat_file",
    "pg_ls_dir", "pg_ls_logdir", "pg_ls_waldir", "pg_ls_archive_statusdir",
    "pg_ls_tmpdir", "pg_ls_replslotdir", "pg_ls_logicalmapdir",
    "pg_ls_logicalsnapdir",
  ],
  large_object: [
    "lo_import", "lo_export", "lo_get", "lo_put", "lo_from_bytea",
    "loread", "lowrite", "lo_create", "lo_creat", "lo_open", "lo_unlink",
  ],
  remote: [
    "dblink", "dblink_connect", "dblink_connect_u", "dblink_exec",
    "dblink_open", "dblink_fetch", "dblink_send_query", "dblink_get_result",
  ],
  // current_setting can read the mask salt; set_config can change the session.
  session_config: ["current_setting", "set_config"],
  // The first argument is a rowtype, so Postgres reads a table's shape from
  // the catalog. The *_to_record family takes only json and stays allowed.
  rowtype_deref: [
    "json_populate_record", "jsonb_populate_record",
    "json_populate_recordset", "jsonb_populate_recordset",
  ],
  // Winding a sequence back makes later inserts collide on the primary key.
  // nextval stays allowed: it is part of the ordinary INSERT idiom.
  sequence_write: ["setval"],
  admin: [
    "pg_terminate_backend", "pg_cancel_backend", "pg_reload_conf",
    "pg_rotate_logfile", "pg_promote", "pg_create_restore_point",
    "pg_switch_wal", "pg_drop_replication_slot",
    "pg_create_physical_replication_slot", "pg_create_logical_replication_slot",
  ],
};

const DANGEROUS = new Map<string, DangerFamily>();
for (const [family, names] of Object.entries(FAMILIES)) {
  for (const n of names) DANGEROUS.set(n, family as DangerFamily);
}

/** What a denied function can do, for the denial message. */
export function dangerousCapability(name: string): string | null {
  switch (DANGEROUS.get(name.toLowerCase())) {
    case undefined:
      return null;
    case "dynamic_sql":
      return "runs a SQL statement passed as a string, or serializes a relation named as a string, so it reads tables the policy cannot see";
    case "filesystem":
      return "reads files from the database server's filesystem";
    case "large_object":
      return "reads or writes server-side files and large objects";
    case "remote":
      return "opens a connection to another database server";
    case "session_config":
      return "reads or writes session configuration, which can expose engine internals";
    case "rowtype_deref":
      return "reads a table's definition from the catalog through a rowtype argument";
    case "sequence_write":
      return "writes sequence state, which can force primary-key collisions on later inserts";
    case "admin":
      return "changes database server state";
  }
}

// biome-ignore format: grouped by kind for review
export const MASK_SAFE_FUNCTIONS: ReadonlySet<string> = new Set([
  // aggregates
  "count", "sum", "avg", "min", "max", "every", "bool_and", "bool_or", "bit_and", "bit_or",
  "stddev", "stddev_pop", "stddev_samp", "variance", "var_pop", "var_samp",
  "corr", "covar_pop", "covar_samp",
  "regr_avgx", "regr_avgy", "regr_count", "regr_intercept", "regr_r2", "regr_slope",
  "regr_sxx", "regr_sxy", "regr_syy",
  "mode", "percentile_cont", "percentile_disc",
  "string_agg", "array_agg",
  // window functions
  "row_number", "rank", "dense_rank", "percent_rank", "cume_dist", "ntile",
  "lag", "lead", "first_value", "last_value", "nth_value",
  // math
  "abs", "ceil", "ceiling", "floor", "round", "trunc", "sign", "mod", "power",
  "sqrt", "cbrt", "exp", "ln", "log", "log10", "pi", "div", "gcd", "lcm",
  "greatest", "least", "width_bucket", "scale", "min_scale", "trim_scale",
  "degrees", "radians", "sin", "cos", "tan", "cot", "asin", "acos", "atan", "atan2",
  "sinh", "cosh", "tanh", "factorial",
  // string
  "length", "char_length", "character_length", "bit_length", "octet_length",
  "lower", "upper", "initcap", "trim", "btrim", "ltrim", "rtrim",
  "substr", "substring", "left", "right", "lpad", "rpad", "repeat", "reverse",
  "replace", "translate", "overlay", "concat", "concat_ws", "format",
  "split_part", "position", "strpos", "starts_with", "ascii", "chr",
  "regexp_replace", "regexp_count", "regexp_instr", "regexp_substr",
  "encode", "decode", "md5", "sha224", "sha256", "sha384", "sha512",
  // date and time: the clock and TimeZone are not row data
  "date_trunc", "date_bin", "date_part", "extract", "age", "isfinite",
  "to_char", "to_number", "to_date", "to_timestamp",
  "make_date", "make_time", "make_timestamp", "make_timestamptz", "make_interval",
  "justify_days", "justify_hours", "justify_interval", "now",
  // what SQL syntax desugars to: AT TIME ZONE, SIMILAR TO, OVERLAPS
  "timezone", "similar_to_escape", "overlaps",
  // json built from an explicit argument list: no whole-row overload
  "json_build_object", "jsonb_build_object", "json_build_array", "jsonb_build_array",
]);

// Deliberately excluded (see the old engine's audit of each family): dynamic
// SQL, session settings, files and large objects, object-name dereference
// (pg_relation_size, nextval, pg_get_viewdef, has_*_privilege), admin and
// pg_sleep, whole-row and json/xml serialization (to_json, row_to_json,
// json_agg, xmlelement), and set-returning functions.

// biome-ignore format: grouped by kind for review
export const MASK_SAFE_OPERATORS: ReadonlySet<string> = new Set([
  "=", "<>", "!=", "<", ">", "<=", ">=",
  "+", "-", "*", "/", "%", "^",
  "||",
  "~", "~*", "!~", "!~*",
  "~~", "~~*", "!~~", "!~~*", // LIKE and ILIKE
  "&", "|", "#", "<<", ">>",
]);

// Builtins whose result changes from call to call, or that sleep. A held
// write that calls one gets no preview: counting now can't predict what the
// write will change, and a count that sleeps holds up whoever runs it.
const VOLATILE: ReadonlySet<string> = new Set([
  "pg_sleep",
  "pg_sleep_for",
  "pg_sleep_until",
  "random",
  "random_normal",
  "setseed",
  "nextval",
  "currval",
  "lastval",
  "clock_timestamp",
  "timeofday",
  "gen_random_uuid",
  "uuidv4",
  "uuidv7",
  "uuid_generate_v1",
  "uuid_generate_v1mc",
  "uuid_generate_v4",
]);

export function isVolatile(name: string): boolean {
  return VOLATILE.has(name.toLowerCase());
}
