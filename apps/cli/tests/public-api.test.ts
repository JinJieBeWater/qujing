import { describe, expect, test } from "bun:test";
import { ColleagueLineError, errorCodes } from "../src/errors";

describe("public API", () => {
  test("exposes stable external error codes", () => {
    expect(errorCodes).toEqual([
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
    ]);
    expect(new ColleagueLineError("BUSY", "busy")).toMatchObject({
      name: "ColleagueLineError",
      code: "BUSY",
      message: "busy",
    });
  });
});
