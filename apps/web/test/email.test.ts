// Unit coverage for the Resend wire payload in lib/email.ts. The env gate
// (isEmailConfigured) lives in invites.test.ts; this file pins the POST body —
// specifically reply_to, added so replies to a send-only From address (e.g.
// invites@) land in the support mailbox instead of the void. Same fetch-stub
// posture as loops.test.ts.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  sendOrgInvitationEmail,
  sendPasswordResetEmail,
} from "../src/lib/email.ts";
import { SUPPORT_EMAIL } from "../src/lib/support.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function stubResend() {
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("EMAIL_FROM", "Midplane <invites@midplane.ai>");
  const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("transactional sends carry reply_to = the support mailbox", () => {
  it("invitation email", async () => {
    const fetchMock = stubResend();
    await sendOrgInvitationEmail({
      to: "new@teammate.co",
      orgName: "Acme",
      inviterName: "Dana",
      inviterEmail: "dana@acme.co",
      inviteLink: "https://app.midplane.ai/accept-invitation/abc",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    const body = JSON.parse(init.body as string);
    expect(body.reply_to).toBe(SUPPORT_EMAIL);
    // reply_to rides alongside the unchanged fields, not instead of them.
    expect(body.from).toBe("Midplane <invites@midplane.ai>");
    expect(body.to).toBe("new@teammate.co");
  });

  it("password-reset email (both public senders share the send path)", async () => {
    const fetchMock = stubResend();
    await sendPasswordResetEmail({
      to: "user@x.co",
      resetUrl: "https://app.midplane.ai/reset-password?token=t",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).reply_to).toBe(SUPPORT_EMAIL);
  });
});
