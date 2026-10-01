// Mask transforms as SQL expression trees. Every function and operator is
// qualified with pg_catalog, so a user-defined overload can't take its place.

import type { MaskRule } from "@midplane/protocol";
import type { Node } from "@pgsql/types";

/** The session setting the gateway sets, and reads back, before a masked statement. */
export const MASK_SALT_SETTING = "midplane.mask_salt";

// pg_type.typcategory values the transforms key on.
const STRING = "S";
const DATETIME = "D";
const NUMERIC = "N";

const name = (n: string): Node => ({ String: { sval: n } });
const qualified = (n: string): Node[] => [name("pg_catalog"), name(n)];
const text = (s: string): Node => ({ A_Const: { sval: { sval: s } } });
const bool = (b: boolean): Node => ({ A_Const: { boolval: { boolval: b } } });

function number(n: number): Node {
  return Number.isInteger(n)
    ? { A_Const: { ival: { ival: n } } }
    : { A_Const: { fval: { fval: String(n) } } };
}

function call(fn: string, ...args: Node[]): Node {
  return {
    FuncCall: {
      funcname: qualified(fn),
      args,
      funcformat: "COERCE_EXPLICIT_CALL",
    },
  };
}

function op(o: string, lexpr: Node, rexpr: Node): Node {
  return { A_Expr: { kind: "AEXPR_OP", name: qualified(o), lexpr, rexpr } };
}

/** A cast to `text`, spelled as the parser spells it (pg_catalog is searched first). */
function castText(arg: Node): Node {
  return {
    TypeCast: { arg, typeName: { names: [name("text")], typemod: -1 } },
  };
}

/** A cast to `date`, spelled as the parser spells it. */
function castDate(arg: Node): Node {
  return {
    TypeCast: { arg, typeName: { names: [name("date")], typemod: -1 } },
  };
}

/** NULL with the column's own type: `CASE WHEN false THEN col END`. */
function typedNull(col: Node): Node {
  return {
    CaseExpr: { args: [{ CaseWhen: { expr: bool(false), result: col } }] },
  };
}

export type MaskOutcome =
  | { ok: true; expr: Node }
  | { ok: false; reason: string };

/**
 * The expression that replaces `col` (a column reference over the base
 * relation). `column.category` is its pg_type.typcategory and `column.type`
 * its type as Postgres prints it. A transform that doesn't fit the column's
 * type fails, so the statement is denied rather than run with a mask
 * Postgres would reject or misapply.
 */
export function maskExpression(
  rule: Exclude<MaskRule, "none">,
  col: Node,
  column: { category: string; type: string },
): MaskOutcome {
  const { category } = column;
  const fail = (reason: string): MaskOutcome => ({ ok: false, reason });
  if (rule === "null-out") return { ok: true, expr: typedNull(col) };
  if (rule === "full-redact") {
    // Text becomes a fixed token; other types become NULL of their own type.
    return {
      ok: true,
      expr: category === STRING ? castText(text("***")) : typedNull(col),
    };
  }
  if (rule === "consistent-hash") {
    if (category !== STRING)
      return fail("consistent-hash applies to text columns only");
    const salted = call(
      "textcat",
      call("current_setting", text(MASK_SALT_SETTING)),
      col,
    );
    return {
      ok: true,
      expr: call(
        "encode",
        call("sha256", call("convert_to", salted, text("UTF8"))),
        text("hex"),
      ),
    };
  }
  switch (rule.t) {
    case "partial": {
      if (category !== STRING)
        return fail("partial applies to text columns only");
      const keep = rule.keepStart + rule.keepEnd;
      const length = call("length", col);
      const glyph = text(rule.glyph);
      // A value no longer than the kept window is masked whole, never revealed.
      const whole = call("repeat", glyph, {
        MinMaxExpr: {
          op: "IS_GREATEST",
          args: [call("length", col), number(1)],
        },
      });
      const middle = call(
        "repeat",
        glyph,
        op("-", call("length", col), number(keep)),
      );
      const revealed = call(
        "textcat",
        call("textcat", call("left", col, number(rule.keepStart)), middle),
        call("right", col, number(rule.keepEnd)),
      );
      return {
        ok: true,
        expr: {
          CaseExpr: {
            args: [
              {
                CaseWhen: {
                  expr: op("<=", length, number(keep)),
                  result: whole,
                },
              },
            ],
            defresult: revealed,
          },
        },
      };
    }
    case "generalize": {
      const g = rule.granularity;
      if (typeof g === "string") {
        if (category !== DATETIME)
          return fail(
            `generalize to ${g} applies to date and time columns only`,
          );
        const truncated = call("date_trunc", text(g), col);
        // date_trunc has no date form: a date comes back as timestamptz
        // unless it is cast back to its own type.
        return {
          ok: true,
          expr: column.type === "date" ? castDate(truncated) : truncated,
        };
      }
      if (category !== NUMERIC)
        return fail("a numeric bucket applies to numeric columns only");
      return {
        ok: true,
        expr: op("*", call("floor", op("/", col, number(g))), number(g)),
      };
    }
    case "noise": {
      if (category !== NUMERIC)
        return fail("noise applies to numeric columns only");
      // (random() * 2 - 1) * ratio is uniform in ±ratio. Breaks joins by design.
      const jitter = op(
        "*",
        op("-", op("*", call("random"), number(2)), number(1)),
        number(rule.ratio),
      );
      return { ok: true, expr: op("*", col, op("+", number(1), jitter)) };
    }
  }
}
