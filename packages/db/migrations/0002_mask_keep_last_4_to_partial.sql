-- Value-shape migration for column_masks (masking phase 2.1).
--
-- The masking transform value moved from a bare string to a discriminated union:
-- the param-free presets (full-redact / null-out / consistent-hash) keep their
-- bare-string form, while parametric transforms become tagged objects. The only
-- v1 parametric transform baked into a name was "keep-last-4"; it is retired and
-- absorbed by { "t": "partial", "keepEnd": 4 }. This rewrites any stored
-- "keep-last-4" leaf in the column_masks jsonb to the object form so the engine
-- (which no longer accepts the retired name) reads them. Preset values are
-- untouched. A back-compat reader (validateColumnMasks/normalizeMaskRule)
-- normalizes the same value at read time; this codemod fixes the data at rest.
--
-- Set-based (no PK needed). The LIKE guard limits the touched rows AND makes the
-- migration a no-op once applied — no "keep-last-4" remains to match.
UPDATE "project_databases" pd
SET "column_masks" = (
  SELECT jsonb_object_agg(
    tbl.key,
    (
      SELECT jsonb_object_agg(
        col.key,
        CASE
          WHEN col.value = '"keep-last-4"'::jsonb
            THEN '{"t":"partial","keepEnd":4}'::jsonb
          ELSE col.value
        END
      )
      FROM jsonb_each(tbl.value) AS col
    )
  )
  FROM jsonb_each(pd."column_masks") AS tbl
)
WHERE pd."column_masks" <> '{}'::jsonb
  AND pd."column_masks"::text LIKE '%keep-last-4%';
