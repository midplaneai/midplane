import { isSelfHost } from "./self-host.ts";

// Transactional email via Resend (https://resend.com).
//
// We call Resend's REST endpoint directly with fetch rather than pulling the
// `resend` SDK: it's a single transactional send, the SDK is a thin wrapper over
// this same POST, and fetch keeps the dependency surface (and bun.lock) untouched
// and runtime-agnostic. Mirrors the lib/billing.ts shape (env gate + lazy use).
//
// Configured ONLY in the CLOUD build with both vars present. Self-host ships no
// SMTP/Resend (keyless), so isEmailConfigured() is always false there and the
// invite flow falls back to the copyable link surfaced in /settings — no email.
// Keyless cloud dev (no Resend vars) is also false, so a laptop boots fine and
// the same link fallback applies.

/** The two cloud-only Resend vars. Documented in .env.example. */
interface EmailEnv {
  apiKey: string;
  /** The verified From address, e.g. "Midplane <invites@midplane.ai>". */
  from: string;
}

type EnvLike = Record<string, string | undefined>;

function readEmailEnv(env: EnvLike = process.env): Partial<EmailEnv> {
  return { apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM };
}

/** True when this process can send email: the CLOUD build with both Resend vars.
 *  Self-host is always false (and never reads the env). Mirrors
 *  isBillingConfigured(). */
export function isEmailConfigured(env: EnvLike = process.env): boolean {
  if (isSelfHost()) return false;
  const e = readEmailEnv(env);
  return Boolean(e.apiKey && e.from);
}

/** The validated env, or throw — only call behind isEmailConfigured(). */
function requireEmailEnv(): EmailEnv {
  const e = readEmailEnv();
  if (!e.apiKey || !e.from) {
    throw new Error(
      "Resend email env incomplete (RESEND_API_KEY / EMAIL_FROM)",
    );
  }
  return e as EmailEnv;
}

/** Send one transactional email through Resend. Throws on a non-2xx response;
 *  callers that must not fail the surrounding operation wrap this in try/catch.
 *  Only call behind isEmailConfigured(). */
async function sendEmail(args: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<void> {
  const env = requireEmailEnv();
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.from,
      to: args.to,
      subject: args.subject,
      html: args.html,
      text: args.text,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Resend send failed (${res.status}): ${body.slice(0, 300)}`,
    );
  }
}

/** Minimal HTML escape for the few interpolated strings (org/inviter names) so a
 *  name with `<`/`&` can't break the markup. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Send a workspace invitation email. Best-effort at the call site (auth.ts wraps
 *  it in try/catch so a Resend outage never blocks invite creation — the owner
 *  can still copy the link from /settings). */
export async function sendOrgInvitationEmail(args: {
  to: string;
  orgName: string;
  inviterName: string | null;
  inviterEmail: string;
  inviteLink: string;
}): Promise<void> {
  const inviter = args.inviterName?.trim() || args.inviterEmail;
  const org = args.orgName;
  const subject = `${inviter} invited you to ${org} on Midplane`;

  const text = [
    `${inviter} (${args.inviterEmail}) invited you to join ${org} on Midplane.`,
    "",
    "Accept the invitation:",
    args.inviteLink,
    "",
    "This link is tied to your email address and expires in 7 days.",
    "If you weren't expecting this, you can ignore this email.",
  ].join("\n");

  const html = `<!doctype html>
<html>
  <body style="margin:0;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#111111;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;padding:40px 24px;">
      <tr><td>
        <p style="font-size:15px;line-height:1.6;margin:0 0 16px;">
          <strong>${esc(inviter)}</strong> invited you to join
          <strong>${esc(org)}</strong> on Midplane.
        </p>
        <p style="margin:0 0 28px;">
          <a href="${args.inviteLink}"
             style="display:inline-block;background:#111111;color:#ffffff;text-decoration:none;font-size:14px;font-weight:500;padding:12px 20px;border-radius:6px;">
            Accept invitation
          </a>
        </p>
        <p style="font-size:13px;line-height:1.6;color:#666666;margin:0 0 8px;">
          Or paste this link into your browser:
        </p>
        <p style="font-size:12px;line-height:1.6;color:#666666;word-break:break-all;margin:0 0 28px;">
          <a href="${args.inviteLink}" style="color:#666666;">${args.inviteLink}</a>
        </p>
        <p style="font-size:12px;line-height:1.6;color:#999999;margin:0;border-top:1px solid #eeeeee;padding-top:16px;">
          This link is tied to <strong>${esc(args.to)}</strong> and expires in 7 days.
          If you weren't expecting this, you can ignore this email.
        </p>
      </td></tr>
    </table>
  </body>
</html>`;

  await sendEmail({ to: args.to, subject, html, text });
}
