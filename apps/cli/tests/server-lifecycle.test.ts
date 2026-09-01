import { describe, expect, test } from "bun:test";
import { createFatalHandler } from "../src/server";

describe("Gateway fatal shutdown", () => {
  test("closes once before terminating", async () => {
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    let closes = 0;
    const terminated: Error[] = [];
    const fatal = createFatalHandler(
      async () => {
        closes++;
        await closeGate;
      },
      (error) => terminated.push(error),
      100,
    );

    fatal(new Error("first"));
    fatal(new Error("second"));
    await Bun.sleep(0);
    expect(closes).toBe(1);
    expect(terminated).toEqual([]);

    releaseClose();
    await Bun.sleep(0);
    expect(terminated.map((error) => error.message)).toEqual(["first"]);
  });

  test("terminates after the shutdown deadline", async () => {
    const terminated: Error[] = [];
    const fatal = createFatalHandler(
      () => new Promise<void>(() => {}),
      (error) => terminated.push(error),
      5,
    );

    fatal(new Error("fatal"));
    await Bun.sleep(15);
    expect(terminated.map((error) => error.message)).toEqual(["fatal"]);
  });
});
