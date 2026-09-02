import { describe, expect, test } from "bun:test";
import { Effect, Exit, Scope } from "effect";
import { createScopedFatalHandler } from "../src/server";

describe("Gateway fatal shutdown", () => {
  test("closes scoped resources once before terminating", async () => {
    const scope = await Effect.runPromise(Scope.make("sequential"));
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    let closes = 0;
    const terminated: Error[] = [];
    await Effect.runPromise(
      Scope.addFinalizer(
        scope,
        Effect.tryPromise({
          try: async () => {
            closes++;
            await closeGate;
          },
          catch: (error) => error,
        }).pipe(Effect.orDie),
      ),
    );
    const fatal = createScopedFatalHandler(scope, (error) => terminated.push(error), 100);

    fatal(new Error("first"));
    fatal(new Error("second"));
    await Bun.sleep(0);
    expect(closes).toBe(1);
    expect(terminated).toEqual([]);

    releaseClose();
    await Bun.sleep(0);
    expect(terminated.map((error) => error.message)).toEqual(["first"]);
  });

  test("terminates after scoped shutdown deadline", async () => {
    const scope = await Effect.runPromise(Scope.make("sequential"));
    const terminated: Error[] = [];
    await Effect.runPromise(Scope.addFinalizer(scope, Effect.never));
    const fatal = createScopedFatalHandler(scope, (error) => terminated.push(error), 5);

    fatal(new Error("fatal"));
    await Bun.sleep(15);
    expect(terminated.map((error) => error.message)).toEqual(["fatal"]);
    await Effect.runPromise(Scope.close(scope, Exit.void).pipe(Effect.timeout("1 millis")));
  });
});
