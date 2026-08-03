import { describe, expect, it } from "vitest";

import { isPendingConsentRow } from "@/lib/consent-request";

// The precondition that stops a stale consent page rewriting a live agent's
// grant set. Real incident: a user clicked Allow, saw no feedback (the page
// hands off to a blank loopback callback), and clicked again. The first click
// had already succeeded — the second re-ran the replace-all grant write against
// a consent code the plugin had consumed 3s earlier, then 401'd. Same selection
// that time, so nothing was lost; a changed selection would have clobbered the
// working grants.
//
// Every branch fails CLOSED. "Not provably pending" must never mean "write it".

const NOW = 1_700_000_000_000;
const SUBJECT = { clientId: "client-1", userId: "user-1" };

function row(
  value: Record<string, unknown>,
  expiresAt = new Date(NOW + 60_000),
) {
  return { value: JSON.stringify(value), expiresAt };
}

const PENDING = {
  clientId: "client-1",
  userId: "user-1",
  requireConsent: true,
  scope: ["openid", "mcp"],
  redirectURI: "http://127.0.0.1:51234/callback",
};

describe("isPendingConsentRow", () => {
  it("accepts a live, unconsumed request for this user and client", () => {
    expect(isPendingConsentRow(row(PENDING), SUBJECT, NOW)).toBe(true);
  });

  // The plugin consumes a consent code by rewriting the row's identifier to the
  // new authorization code, so the lookup finds nothing on a second submit.
  it("refuses when the code was already consumed (no row)", () => {
    expect(isPendingConsentRow(null, SUBJECT, NOW)).toBe(false);
  });

  // The other half of consumption: the plugin also flips requireConsent to
  // false. A row in that state is a decided request, not a pending one.
  it("refuses when the request no longer requires consent", () => {
    expect(
      isPendingConsentRow(row({ ...PENDING, requireConsent: false }), SUBJECT, NOW),
    ).toBe(false);
  });

  it("refuses a truthy-but-not-true requireConsent (no coercion)", () => {
    expect(
      isPendingConsentRow(row({ ...PENDING, requireConsent: "yes" }), SUBJECT, NOW),
    ).toBe(false);
  });

  it("refuses an expired request", () => {
    expect(
      isPendingConsentRow(row(PENDING, new Date(NOW - 1)), SUBJECT, NOW),
    ).toBe(false);
  });

  it("refuses at the exact expiry instant (boundary is closed)", () => {
    expect(
      isPendingConsentRow(row(PENDING, new Date(NOW)), SUBJECT, NOW),
    ).toBe(false);
  });

  // Subject binding — this is what makes the check more than a liveness probe.
  // A consent code lifted from another session must not drive a grant write
  // under the signed-in user's identity.
  it("refuses when the request belongs to a different user", () => {
    expect(
      isPendingConsentRow(row({ ...PENDING, userId: "user-2" }), SUBJECT, NOW),
    ).toBe(false);
  });

  it("refuses when the request belongs to a different client", () => {
    expect(
      isPendingConsentRow(row({ ...PENDING, clientId: "client-2" }), SUBJECT, NOW),
    ).toBe(false);
  });

  it("refuses when the subject fields are absent entirely", () => {
    expect(
      isPendingConsentRow(row({ requireConsent: true }), SUBJECT, NOW),
    ).toBe(false);
  });

  it("refuses an unparseable verification value", () => {
    expect(
      isPendingConsentRow(
        { value: "not json{", expiresAt: new Date(NOW + 60_000) },
        SUBJECT,
        NOW,
      ),
    ).toBe(false);
  });

  // JSON.parse("null") succeeds and yields null — the property reads that
  // follow would throw without the object guard.
  it("refuses a value that parses to null", () => {
    expect(
      isPendingConsentRow(
        { value: "null", expiresAt: new Date(NOW + 60_000) },
        SUBJECT,
        NOW,
      ),
    ).toBe(false);
  });

  it("refuses a value that parses to a non-object", () => {
    expect(
      isPendingConsentRow(
        { value: '"a string"', expiresAt: new Date(NOW + 60_000) },
        SUBJECT,
        NOW,
      ),
    ).toBe(false);
  });
});
