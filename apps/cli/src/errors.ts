export const errorCodes = [
  "UNAUTHORIZED",
  "LINE_NOT_FOUND",
  "LINE_UNAVAILABLE",
  "OWNER_ID_MISMATCH",
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

export class ColleagueLineError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ColleagueLineError";
    this.code = code;
  }
}
