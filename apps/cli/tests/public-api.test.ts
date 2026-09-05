import { describe, expect, test } from "bun:test";
import { QujingError, errorCodes } from "../src/errors";

describe("public API", () => {
  test("exposes stable external error codes", () => {
    expect(errorCodes).toEqual([
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
    ]);
    expect(new QujingError("BUSY", "busy")).toMatchObject({
      name: "QujingError",
      code: "BUSY",
      message: "busy",
    });
  });
});
