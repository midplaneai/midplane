import type { RuleId } from "@midplane/protocol";

/**
 * A verdict of deny, thrown from anywhere in the pipeline. `evaluate` catches
 * it; nothing else may. The first denial reached is the one reported.
 */
export class Deny extends Error {
  readonly rule: RuleId;
  readonly reason: string;

  constructor(rule: RuleId, reason: string) {
    super(reason);
    this.name = "Deny";
    this.rule = rule;
    this.reason = reason;
  }
}

/** Deny as `unsupported`: the engine does not understand this construct. */
export function unsupported(what: string): Deny {
  return new Deny(
    "unsupported",
    `Midplane denied this query because it uses ${what}, which Midplane does not support. Anything Midplane can't analyze is denied.`,
  );
}
