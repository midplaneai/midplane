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
