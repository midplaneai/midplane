// Pure predicate for "is this OAuth consent request still pending?".
//
// Lives here rather than beside its caller in app/oauth/consent/actions.ts
// because that file is `"use server"`, where Next.js requires EVERY export to be
// an async function — a sync helper exported from there fails the build. Same
// split as scope-grants' dedupeSelections: the decision logic is pure and
// unit-tested, the DB read stays in the action.

/** The shape the oidc-provider plugin stores for a pending authorization
 *  request: a `verification` row keyed by the consent code, whose `value` is
 *  the JSON-encoded request. */
export interface ConsentVerificationRow {
  value: string;
  expiresAt: Date;
}

/** Is this verification row an unconsumed, unexpired authorization request
 *  belonging to `subject`?
 *
 *  The plugin CONSUMES a consent code on a successful decision by rewriting the
 *  row's identifier to the freshly-minted authorization code and flipping
 *  `requireConsent` to false. So "findable under the consent code, unexpired,
 *  still requires consent" is the plugin's own precondition for accepting a
 *  decision — checking it before writing grants keeps the grant write from
 *  outliving the request it belongs to.
 *
 *  Fails CLOSED on every branch: a missing row, an expired one, an unparseable
 *  value, or a mismatched subject all mean "not pending". */
export function isPendingConsentRow(
  row: ConsentVerificationRow | null,
  subject: { clientId: string; userId: string },
  now: number = Date.now(),
): boolean {
  if (!row) return false;
  if (row.expiresAt.getTime() <= now) return false;
  let value: { requireConsent?: unknown; userId?: unknown; clientId?: unknown };
  try {
    value = JSON.parse(row.value);
  } catch {
    return false;
  }
  // JSON.parse("null") succeeds and yields null; the property reads below would
  // throw without this guard.
  if (!value || typeof value !== "object") return false;
  // The subject check is what makes this more than a liveness probe: it binds
  // the grant write to the identity the authorize step recorded, so a code
  // lifted from another session can't drive a grant write under this one.
  // Strict === on requireConsent — no truthiness coercion on a security gate.
  return (
    value.requireConsent === true &&
    value.userId === subject.userId &&
    value.clientId === subject.clientId
  );
}
