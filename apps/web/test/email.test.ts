// Unit coverage for the Resend wire payload in lib/email.ts. The env gate
// (isEmailConfigured) lives in invites.test.ts; this file pins the POST body —
// specifically reply_to, added so replies to a send-only From address (e.g.
// invites@) land in the support mailbox instead of the void. Same fetch-stub
// posture as loops.test.ts.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  sendOrgInvitationEmail,
  sendPasswordResetEmail,
  sendVerificationEmail,
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

  it("verification email", async () => {
    const fetchMock = stubResend();
    await sendVerificationEmail({
      to: "new@user.co",
      verifyUrl: "https://app.midplane.ai/api/auth/verify-email?token=t",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.reply_to).toBe(SUPPORT_EMAIL);
    expect(body.to).toBe("new@user.co");
    // The link must survive into BOTH renderings — a text-only or html-only
    // verification mail is a dead end for whichever client the user has.
    expect(body.html).toContain(
      "https://app.midplane.ai/api/auth/verify-email?token=t",
    );
    expect(body.text).toContain(
      "https://app.midplane.ai/api/auth/verify-email?token=t",
    );
  });
});

// These templates are hand-written HTML strings with no framework escaping
// behind them, so esc() is the ONLY thing standing between an attacker-chosen
// display name and markup injection into a recipient's inbox. A signup in the
// wild planted a tag-breakout probe in `user.name`, which is exactly the shape
// that reaches inviterName here.
describe("interpolated names are HTML-escaped in the invitation email", () => {
  function invitationHtml(fetchMock: ReturnType<typeof stubResend>): string {
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return JSON.parse(init.body as string).html as string;
  }

  it("neutralizes a tag-breakout payload in the inviter name", async () => {
    const fetchMock = stubResend();
    await sendOrgInvitationEmail({
      to: "new@teammate.co",
      orgName: "Acme",
      inviterName: '"><script src="https://evil.example/x.js"></script>',
      inviterEmail: "dana@acme.co",
      inviteLink: "https://app.midplane.ai/accept-invitation/abc",
    });
    const html = invitationHtml(fetchMock);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("evil.example/x.js\"></script>");
    expect(html).toContain("&lt;script");
  });

  it("escapes quotes, so a name stays inert in attribute context too", async () => {
    // Every current interpolation is in element text, where quotes are
    // harmless — this pins the stronger contract so that moving one of these
    // into title="…"/style="…" can't silently open an injection path.
    const fetchMock = stubResend();
    await sendOrgInvitationEmail({
      to: "new@teammate.co",
      orgName: `Acme" onmouseover="alert(1)`,
      inviterName: "O'Brien & Sons",
      inviterEmail: "dana@acme.co",
      inviteLink: "https://app.midplane.ai/accept-invitation/abc",
    });
    const html = invitationHtml(fetchMock);
    expect(html).toContain("&quot; onmouseover=&quot;alert(1)");
    expect(html).toContain("O&#39;Brien &amp; Sons");
    expect(html).not.toContain('Acme" onmouseover=');
  });
});
