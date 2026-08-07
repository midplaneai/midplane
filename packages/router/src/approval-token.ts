// Per-project bearer token for the write-approval gate.
//
// The engine posts held writes to the control plane and has to prove two things:
// that it is one of our engines at all, and WHICH project it speaks for. A single
// shared secret across every engine proves only the first. It would leave the
// project id — which arrives in the URL the spawner injected — as the sole claim
// of identity, so an engine that could rewrite its own env could file approval
// requests against another customer's project and, worse, collect grants meant
// for them.
//
// So the token IS the project binding: HMAC(master, projectId). The endpoint
// recomputes it from the project id in the path and compares in constant time.
// A token minted for project A simply doesn't verify against project B, and the
// master secret never leaves the control plane.
//
// Same construction as the per-project mask salt in proxy.ts — one master
// secret, one HMAC per project — so there is one convention to reason about.

import { createHmac, timingSafeEqual } from "node:crypto";

/** Deterministic per-project token. Stable across spawns, so a warm container
 *  keeps working and a respawn mints the same value. */
export function mintApprovalToken(master: string, projectId: string): string {
  if (!master) {
    throw new Error("mintApprovalToken: master secret is required");
  }
  if (!projectId) {
    throw new Error("mintApprovalToken: projectId is required");
  }
  return createHmac("sha256", master).update(projectId).digest("hex");
}

/** Constant-time verify. Returns false rather than throwing on any malformed
 *  input — a caller must never be able to distinguish "bad shape" from "wrong
 *  token" by catching an exception. */
export function verifyApprovalToken(
  master: string,
  projectId: string,
  presented: string | null | undefined,
): boolean {
  if (!master || !projectId || !presented) return false;

  let expected: string;
  try {
    expected = mintApprovalToken(master, projectId);
  } catch {
    return false;
  }

  // timingSafeEqual throws on a length mismatch, which would itself be a timing
  // signal. Both sides are fixed-width sha256 hex, so a length difference means
  // the token is malformed — reject without comparing.
  if (presented.length !== expected.length) return false;

  try {
    return timingSafeEqual(Buffer.from(presented, "utf8"), Buffer.from(expected, "utf8"));
  } catch {
    return false;
  }
}

/** Pull the bearer out of an Authorization header. Null for anything that
 *  isn't exactly one `Bearer <token>`. */
export function bearerFrom(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer[ ]+(\S+)$/.exec(header.trim());
  return m ? m[1]! : null;
}
