// Support contact constants, in one place so a change is a single edit (and so
// client components can import them without pulling in anything Node-only —
// same contract as lib/docs.ts).

/** The general support mailbox. A human (the founder) reads and answers. */
export const SUPPORT_EMAIL = "support@midplane.ai";

/** GitHub issues for the OSS repo — the community support channel alongside
 *  Discussions (see SUPPORT.md). */
export const GITHUB_ISSUES_URL =
  "https://github.com/midplaneai/midplane/issues";

/** Build a mailto: URL for the support mailbox with an optional prefilled
 *  subject/body. encodeURIComponent (not URLSearchParams) because mail clients
 *  expect %20 for spaces, not `+`. */
export function supportMailto(args?: {
  subject?: string;
  body?: string;
}): string {
  const parts: string[] = [];
  if (args?.subject) parts.push(`subject=${encodeURIComponent(args.subject)}`);
  if (args?.body) parts.push(`body=${encodeURIComponent(args.body)}`);
  return parts.length
    ? `mailto:${SUPPORT_EMAIL}?${parts.join("&")}`
    : `mailto:${SUPPORT_EMAIL}`;
}

/** Pre-filled support mailto for an error boundary — owns the ref/host/path/
 *  time report format PostHog correlation relies on, so the two boundaries
 *  (error.tsx, global-error.tsx) can't drift apart. Client-side use: host and
 *  path come from window when available (the hostname encodes the region;
 *  the mp_region cookie is httpOnly and unreadable here). `fallbackRef`
 *  labels errors that carry no digest (client render errors, root-layout
 *  failures). */
export function supportErrorMailto(
  digest: string | undefined,
  fallbackRef: string,
): string {
  const ref = digest ?? fallbackRef;
  const onClient = typeof window !== "undefined";
  const detail = [
    `ref: ${ref}`,
    onClient ? `host: ${window.location.hostname}` : null,
    onClient ? `path: ${window.location.pathname}` : null,
    `time: ${new Date().toISOString()}`,
  ]
    .filter(Boolean)
    .join("\n");
  return supportMailto({
    subject: `App error (${ref})`,
    body: `What were you doing when this happened?\n\n\n---\n${detail}\n`,
  });
}
