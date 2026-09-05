export const errorCodes = [
  "UNAUTHORIZED",
  "PEER_NOT_FOUND",
  "PEER_UNAVAILABLE",
  "NODE_ID_MISMATCH",
  "CANCELLED",
  "WORKSPACE_NOT_FOUND",
  "WORKSPACE_UNAVAILABLE",
  "INVALID_QUESTION",
  "RUNTIME_UNAVAILABLE",
  "RUNTIME_TIMEOUT",
  "RUNTIME_FAILED",
  "BUSY",
] as const;

export type ErrorCode = (typeof errorCodes)[number];

export class QujingError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "QujingError";
    this.code = code;
  }
}
