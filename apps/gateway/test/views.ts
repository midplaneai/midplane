// Views as people write them, each seeding values the cloud must never see:
// the string s3cr3t and the numbers 4711 and 47.11. Postgres prints them back
// through pg_get_viewdef, the gateway redacts that, and the core's
// postgres-views corpus catalog is what the gateway read from them on
// Postgres 17. The two gap_ views are printed in forms pgsql-deparser can't
// say faithfully, so their definitions are withheld.

export const SEEDED = ["s3cr3t", "4711", "47.11"];

export const VIEW_TABLES = `
  CREATE TABLE t (id int PRIMARY KEY, name text, email varchar(200), amount numeric(12,2),
    at timestamptz, d date, tm time, data jsonb, tags text[], code char(3), flag boolean,
    kind "char", bits bit(4), ip inet);
  CREATE TABLE u (id int, t_id int, note text);
`;

const S = "s3cr3t";
const N = "4711";

export const VIEWS: Record<string, string> = {
  in_list: `SELECT id FROM t WHERE name IN ('${S}', 'bob')`,
  any_array: `SELECT id FROM t WHERE id = ANY (ARRAY[${N}, 2, 3])`,
  between: `SELECT id FROM t WHERE amount BETWEEN ${N} AND 47.11`,
  like_ilike: `SELECT id FROM t WHERE name LIKE '${S}%' OR name ILIKE '%${S}' OR name SIMILAR TO '${S}%' OR name ~ '^${S}'`,
  interval_math: `SELECT id, at - interval '${N} days' AS since, now() - '${N} hour'::interval AS h FROM t`,
  current_values:
    "SELECT id, CURRENT_DATE AS cd, CURRENT_TIMESTAMP AS ct, LOCALTIME AS lt, current_user AS cu FROM t",
  extract:
    "SELECT id, EXTRACT(year FROM at) AS y, EXTRACT(epoch FROM at) AS e, date_part('month', at) AS m, date_trunc('week', at) AS w FROM t",
  normalize:
    "SELECT id, normalize(name, NFKC) AS n, name IS NFC NORMALIZED AS nn FROM t",
  at_time_zone: `SELECT id, at AT TIME ZONE '${S}/Zone' AS z FROM t`,
  coalesce: `SELECT id, COALESCE(name, '${S}') AS n, NULLIF(email, '') AS e, GREATEST(amount, ${N}) AS g FROM t`,
  case_: `SELECT id, CASE kind WHEN 'a' THEN '${S}' ELSE 'other' END AS k, CASE WHEN amount > ${N} THEN 'big' END AS size FROM t`,
  string_fns: `SELECT id, substring(name from ${N} for 3) AS s1, substring(name, 2) AS s2, trim(both '${S}' from name) AS tr, position('${S}' in email) AS p, overlay(name placing '${S}' from 1 for 1) AS o, upper(name) || '${S}' || lower(name) AS ul FROM t`,
  json_ops: `SELECT id, data -> '${S}' AS a, data ->> 'b' AS b, data #>> '{${S},d}' AS cd, data ? '${S}' AS has_e, jsonb_build_object('${S}', name) AS obj FROM t`,
  aggregates: `SELECT name, count(*) FILTER (WHERE amount > ${N}) AS n, string_agg(email, '${S}' ORDER BY email) AS emails, sum(amount) AS s FROM t GROUP BY name HAVING count(*) > ${N}`,
  windows: `SELECT id, row_number() OVER (PARTITION BY name ORDER BY at DESC) AS rn, lag(amount, ${N}, 0) OVER w AS prev FROM t WINDOW w AS (ORDER BY id ROWS ${N} PRECEDING)`,
  joins: `SELECT t.id, u.note FROM t JOIN u ON u.t_id = t.id AND u.note <> '${S}' LEFT JOIN LATERAL (SELECT ${N} AS one) l ON true`,
  subqueries: `SELECT id, (SELECT count(*) FROM u WHERE u.t_id = t.id) AS n FROM t WHERE EXISTS (SELECT 1 FROM u WHERE u.note = '${S}')`,
  cte_recursive: `WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < ${N}) SELECT n FROM r`,
  limit_offset: `SELECT id FROM t ORDER BY amount LIMIT ${N} OFFSET 47`,
  distinct_on:
    "SELECT DISTINCT ON (name) name, at FROM t ORDER BY name, at DESC",
  casts: `SELECT id, amount::int AS a, d::text AS dt, '${N}'::bigint AS b, name::varchar(10) AS v, code::bpchar AS c, 't'::boolean AS bo, NULL::text AS nt, '2024-01-01'::date AS dd, '12:00'::time AS tt, '${S}'::character varying AS cv FROM t`,
  char_type: `SELECT id, kind = 'a'::"char" AS is_a FROM t`,
  bit_typed: "SELECT id, bits = '1010'::bit(4) AS b FROM t",
  arrays: `SELECT id, tags[${N}] AS first, array_length(tags, 1) AS len, ARRAY['${S}', 'y'] AS xy, '${S}' = ANY(tags) AS has_z FROM t`,
  collated: `SELECT id, name COLLATE "C" AS n FROM t WHERE name > '${S}' ORDER BY name COLLATE "C" NULLS FIRST`,
  quotes: `SELECT id, 'it''s ${S}' AS q, E'tab\\t${S}' AS e, '😀 ${S}' AS u FROM t`,
  values_view: `SELECT * FROM (VALUES (${N}, '${S}'), (2, 'b')) AS v(n, s)`,
  set_ops: `SELECT id FROM t UNION SELECT t_id FROM u EXCEPT SELECT ${N}`,
  grouping_sets:
    "SELECT name, code, count(*) AS n FROM t GROUP BY GROUPING SETS ((name), (code), ())",
  row_cmp: `SELECT id FROM t WHERE (id, name) = (${N}, '${S}') OR ROW(id, amount) IS NOT NULL`,
  inet_ops: "SELECT id FROM t WHERE ip << '10.47.11.0/24'::inet",
  is_distinct: `SELECT id FROM t WHERE name IS DISTINCT FROM '${S}' AND flag IS TRUE AND email IS NOT NULL`,
  numeric_lits: `SELECT id, amount * 47.11 AS a, amount / ${N} AS b, -amount AS c, 4711e3 AS d, 0.0004711 AS e FROM t`,
  to_char: `SELECT id, to_char(at, 'YYYY-${S}') AS day, format('%s <${S}>', name, email) AS f FROM t`,
  regexp: `SELECT id, regexp_replace(email, '@${S}$', '') AS local FROM t`,
  gap_bit_literal: "SELECT id, bits = B'1010' AS b FROM t",
  gap_fetch_ties: `SELECT id FROM t ORDER BY amount FETCH FIRST ${N} ROWS WITH TIES`,
};

/** Every view above, created as `v_<name>`. */
export const CREATE_VIEWS = Object.entries(VIEWS)
  .map(([name, sql]) => `CREATE VIEW v_${name} AS ${sql};`)
  .join("\n");

/** The views whose definitions the gateway withholds. */
export const WITHHELD = ["public.v_gap_bit_literal", "public.v_gap_fetch_ties"];
