// Unit coverage for the cloud-invite pure helpers:
//   - seatInviteBlock (lib/plan.ts): the advisory seat pre-flight that decides
//     whether the invite form is shown vs. an upgrade CTA (members + pending vs
//     the plan cap). Better Auth's membershipLimit is the authoritative enforcer
//     on accept; this is the friendlier gate.
//   - isEmailConfigured (lib/email.ts): the cloud-only Resend env gate; always
//     false in self-host so invites fall back to the copyable link.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CAPS, seatInviteBlock } from "../src/lib/plan.ts";
import { isEmailConfigured } from "../src/lib/email.ts";

describe("seatInviteBlock", () => {
  it("blocks a Free org (cap 1 = owner only)", () => {
    expect(seatInviteBlock({ members: 1, pending: 0 }, CAPS.free)).toEqual({
      limit: 1,
    });
  });

  it("blocks once members + pending reach the cap (oversubscribe guard)", () => {
    // Pro cap 10: 8 members + 2 pending = 10 → full.
    expect(seatInviteBlock({ members: 8, pending: 2 }, CAPS.pro)).toEqual({
      limit: 10,
    });
  });

  it("allows while members + pending are under the cap", () => {
    expect(seatInviteBlock({ members: 3, pending: 2 }, CAPS.pro)).toBeNull();
  });

  it("never blocks an unlimited (Team) seat cap", () => {
    expect(
      seatInviteBlock({ members: 100, pending: 50 }, CAPS.team),
    ).toBeNull();
  });
});

describe("isEmailConfigured", () => {
  const prevSelfHost = process.env.MIDPLANE_SELF_HOST;

  beforeEach(() => {
    delete process.env.MIDPLANE_SELF_HOST;
  });

  afterEach(() => {
    if (prevSelfHost === undefined) delete process.env.MIDPLANE_SELF_HOST;
    else process.env.MIDPLANE_SELF_HOST = prevSelfHost;
  });

  it("is true in cloud with both Resend vars set", () => {
    expect(
      isEmailConfigured({ RESEND_API_KEY: "re_x", EMAIL_FROM: "a@b.com" }),
    ).toBe(true);
  });

  it("is false when either var is missing", () => {
    expect(isEmailConfigured({ RESEND_API_KEY: "re_x" })).toBe(false);
    expect(isEmailConfigured({ EMAIL_FROM: "a@b.com" })).toBe(false);
    expect(isEmailConfigured({})).toBe(false);
  });

  it("is always false in self-host, even with both vars set", () => {
    process.env.MIDPLANE_SELF_HOST = "1";
    expect(
      isEmailConfigured({ RESEND_API_KEY: "re_x", EMAIL_FROM: "a@b.com" }),
    ).toBe(false);
  });
});
