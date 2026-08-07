// Typed exceptions for INFRASTRUCTURE failures only.
// Policy denials are NEVER exceptions — they're a normal Decision return.
//
// Reference: design doc "Code Quality Decisions — Error model".

export class AuditUnavailableError extends Error {
  readonly code = "audit_unavailable" as const;
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "AuditUnavailableError";
  }
}

export class KmsUnavailableError extends Error {
  readonly code = "kms_unavailable" as const;
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "KmsUnavailableError";
  }
}

export class ParserCrashedError extends Error {
  readonly code = "parser_crashed" as const;
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "ParserCrashedError";
  }
}

// The approval gate could not be reached (control plane down, network, 5xx).
//
// This is NOT a denial and must never become one. A DENY would fire the
// deny-webhook, put a refusal nobody made into a compliance export, and reach
// the agent as a permanent "no" for what is a transient outage. Raised BEFORE
// the DECIDED write, so an unreachable gate leaves no decision row at all — the
// query was attempted and never decided, which is exactly what happened.
export class ApprovalUnavailableError extends Error {
  readonly code = "approval_unavailable" as const;
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "ApprovalUnavailableError";
  }
}

// A human has not decided yet — the engine held as long as it safely could and
// the request is still pending.
//
// Also NOT a denial, for the same deny-webhook reason: nobody refused this
// write. Like the unavailable case it is raised before the DECIDED write, so a
// held attempt is an ATTEMPTED row with no decision — which reads as "in
// flight" because it is. The agent re-runs the identical statement to collect.
export class ApprovalPendingError extends Error {
  readonly code = "approval_pending" as const;
  constructor(
    message: string,
    readonly details: {
      approvalId: string;
      /** Absolute ms epoch the pending request stops being claimable. */
      expiresAt: number;
      /** Where a human can act on it, when the gate supplied one. */
      reviewUrl?: string;
    },
  ) {
    super(message);
    this.name = "ApprovalPendingError";
  }
}
