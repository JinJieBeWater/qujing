import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { PiRpcSessionEffect } from "../src/runtime/pi-rpc";
import { makePiRuntime } from "./helpers/pi-runtime";

const workspace = { id: "docs", name: "Docs", summary: "Docs", root: "/tmp/docs" };
const runtimeSession = {
  id: "00000000-0000-4000-8000-000000000001",
  clientId: "client",
  workspaceId: "docs",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function input(question: string, signal = new AbortController().signal) {
  return { workspace, session: runtimeSession, question, signal };
}

describe("PiRuntime", () => {
  test("serializes turns in one runtime session", async () => {
    let active = 0;
    let maximum = 0;
    let answer = "";
    const session: PiRpcSessionEffect = {
      promptEffect: (question) =>
        Effect.promise(async () => {
          active++;
          maximum = Math.max(maximum, active);
          await sleep(10);
          answer = `answer:${question}`;
          active--;
        }),
      isAlive: () => true,
      getLastAssistantText: () => answer,
      clearQueueEffect: () => Effect.void,
      abortEffect: () => Effect.void,
      waitForIdleEffect: () => Effect.void,
      disposeEffect: () => Effect.void,
    };
    const runtime = makePiRuntime({ createSessionEffect: () => Effect.succeed(session) });

    const results = await Promise.all([
      Effect.runPromise(runtime.answerEffect(input("one"))),
      Effect.runPromise(runtime.answerEffect(input("two"))),
    ]);

    expect(maximum).toBe(1);
    expect(results).toEqual([{ answer: "answer:one" }, { answer: "answer:two" }]);
    await Effect.runPromise(runtime.disposeEffect());
  });

  test("clears queues and aborts Pi when caller cancels", async () => {
    const controller = new AbortController();
    let clearCount = 0;
    let abortCount = 0;
    let rejectPrompt: ((error: Error) => void) | undefined;
    const session = fakeSession();
    session.promptEffect = () =>
      Effect.tryPromise({
        try: () =>
          new Promise<void>((_resolve, reject) => {
            rejectPrompt = reject;
          }),
        catch: (error) => error as Error,
      });
    session.clearQueueEffect = () =>
      Effect.promise(async () => {
        clearCount++;
      });
    session.abortEffect = () =>
      Effect.promise(async () => {
        abortCount++;
        rejectPrompt?.(new DOMException("Aborted", "AbortError"));
      });
    const runtime = makePiRuntime({ createSessionEffect: () => Effect.succeed(session) });
    const pending = Effect.runPromise(runtime.answerEffect(input("hello", controller.signal)));
    await sleep(1);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(clearCount).toBe(1);
    expect(abortCount).toBe(1);
  });

  test("cannot return success when abort makes prompt resolve", async () => {
    const controller = new AbortController();
    let resolvePrompt: (() => void) | undefined;
    const session = fakeSession();
    session.promptEffect = () =>
      Effect.tryPromise({
        try: () =>
          new Promise<void>((resolve) => {
            resolvePrompt = resolve;
          }),
        catch: (error) => error as Error,
      });
    session.abortEffect = () =>
      Effect.promise(async () => {
        resolvePrompt?.();
      });
    const runtime = makePiRuntime({ createSessionEffect: () => Effect.succeed(session) });
    const pending = Effect.runPromise(runtime.answerEffect(input("hello", controller.signal)));
    await sleep(1);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  test("fails fatally when Pi does not become idle after abort", async () => {
    const controller = new AbortController();
    let fatal: Error | undefined;
    const session = fakeSession();
    session.promptEffect = () => Effect.never;
    session.waitForIdleEffect = () => Effect.never;
    const runtime = makePiRuntime({
      createSessionEffect: () => Effect.succeed(session),
      abortTimeoutMs: 10,
      fatal: (error) => {
        fatal = error;
      },
    });
    const pending = Effect.runPromise(runtime.answerEffect(input("hello", controller.signal)));
    await sleep(1);

    controller.abort();

    await expect(pending).rejects.toBeDefined();
    expect(fatal?.message).toContain("did not settle");
  });

  test("bounds the full clear, abort, and settlement sequence", async () => {
    const controller = new AbortController();
    let fatal: Error | undefined;
    const session = fakeSession();
    session.promptEffect = () => Effect.never;
    session.clearQueueEffect = () => Effect.never;
    const runtime = makePiRuntime({
      createSessionEffect: () => Effect.succeed(session),
      abortTimeoutMs: 10,
      fatal: (error) => {
        fatal = error;
      },
    });
    const pending = Effect.runPromise(runtime.answerEffect(input("hello", controller.signal)));
    await sleep(1);

    controller.abort();

    await expect(pending).rejects.toBeDefined();
    expect(fatal?.message).toContain("did not settle");
    await Effect.runPromise(runtime.disposeEffect());
  });

  test("releases a Runtime slot after creation fails", async () => {
    let attempts = 0;
    const runtime = makePiRuntime({
      maxRuntimes: 1,
      createSessionEffect: () =>
        Effect.tryPromise({
          try: async () => {
            attempts++;
            if (attempts === 1) throw new Error("startup failed");
            return fakeSession();
          },
          catch: (error) => error,
        }),
    });

    await expect(Effect.runPromise(runtime.answerEffect(input("one")))).rejects.toMatchObject({
      code: "RUNTIME_UNAVAILABLE",
    });
    await expect(Effect.runPromise(runtime.answerEffect(input("two")))).resolves.toEqual({
      answer: "answer",
    });
    await Effect.runPromise(runtime.disposeEffect());
  });

  test("rebinds a queued ask after the cached Pi process dies", async () => {
    let attempts = 0;
    let alive = true;
    let failFirst!: () => void;
    let firstStarted!: () => void;
    const failureGate = new Promise<void>((resolve) => {
      failFirst = resolve;
    });
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const dead = fakeSession();
    dead.promptEffect = () =>
      Effect.tryPromise({
        try: async () => {
          firstStarted();
          await failureGate;
          alive = false;
          throw new Error("Pi exited");
        },
        catch: (error) => error as Error,
      });
    dead.isAlive = () => alive;
    const runtime = makePiRuntime({
      maxRuntimes: 1,
      createSessionEffect: () =>
        Effect.promise(async () => {
          attempts++;
          return attempts === 1 ? dead : fakeSession();
        }),
    });

    const first = Effect.runPromise(runtime.answerEffect(input("one")));
    await started;
    const queued = Effect.runPromise(runtime.answerEffect(input("two")));
    await sleep(0);
    failFirst();

    await expect(first).rejects.toMatchObject({ code: "RUNTIME_FAILED" });
    await expect(queued).resolves.toEqual({ answer: "answer" });
    expect(attempts).toBe(2);
    await Effect.runPromise(runtime.disposeEffect());
  });

  test("counts queue wait inside the ask timeout", async () => {
    let answer = "";
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const session = fakeSession();
    session.promptEffect = (question) =>
      Effect.promise(async () => {
        if (question === "one") {
          firstStarted();
          await firstGate;
        }
        answer = question;
      });
    session.getLastAssistantText = () => answer;
    const timeoutControllers: AbortController[] = [];
    const runtime = makePiRuntime({
      createSessionEffect: () => Effect.succeed(session),
      createTimeoutSignal: () => {
        const controller = new AbortController();
        timeoutControllers.push(controller);
        return controller.signal;
      },
    });

    const first = Effect.runPromise(runtime.answerEffect(input("one")));
    await started;
    const second = Effect.runPromise(runtime.answerEffect(input("two")));
    timeoutControllers[1]!.abort(new DOMException("Timed out", "TimeoutError"));
    await expect(second).rejects.toMatchObject({ code: "RUNTIME_TIMEOUT" });
    releaseFirst();
    await expect(first).resolves.toEqual({ answer: "one" });
    await Effect.runPromise(runtime.disposeEffect());
  });

  test("releases queue capacity when a queued ask is cancelled", async () => {
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const session = fakeSession();
    session.promptEffect = (question) =>
      Effect.promise(async () => {
        if (question !== "one") return;
        firstStarted();
        await firstGate;
      });
    const runtime = makePiRuntime({
      createSessionEffect: () => Effect.succeed(session),
      queueCapacity: 1,
    });
    const first = Effect.runPromise(runtime.answerEffect(input("one")));
    await started;
    const controller = new AbortController();
    const cancelled = Effect.runPromise(runtime.answerEffect(input("two", controller.signal)));
    await sleep(0);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });

    const replacement = Effect.runPromise(runtime.answerEffect(input("three")));
    releaseFirst();
    await expect(Promise.all([first, replacement])).resolves.toHaveLength(2);
    await Effect.runPromise(runtime.disposeEffect());
  });

  test("idle sweep owns disposal and shutdown does not dispose twice", async () => {
    let now = 0;
    let disposals = 0;
    const session = fakeSession();
    session.disposeEffect = () =>
      Effect.promise(async () => {
        disposals++;
      });
    const runtime = makePiRuntime({
      createSessionEffect: () => Effect.succeed(session),
      idleTimeoutMs: 10,
      now: () => now,
    });
    await Effect.runPromise(runtime.answerEffect(input("hello")));
    now = 20;
    await sleep(25);
    expect(disposals).toBe(1);

    await Effect.runPromise(runtime.disposeEffect());
    expect(disposals).toBe(1);
  });

  test("disposes active sessions by Client or Workspace", async () => {
    let aborts = 0;
    let disposals = 0;
    const session = fakeSession();
    session.abortEffect = () =>
      Effect.promise(async () => {
        aborts++;
      });
    session.disposeEffect = () =>
      Effect.promise(async () => {
        disposals++;
      });
    const runtime = makePiRuntime({ createSessionEffect: () => Effect.succeed(session) });
    await Effect.runPromise(runtime.answerEffect(input("hello")));

    await Effect.runPromise(runtime.disposeClientEffect("client"));
    expect(aborts).toBe(0);
    expect(disposals).toBe(1);
    await Effect.runPromise(runtime.answerEffect(input("again")));
    await Effect.runPromise(runtime.disposeWorkspaceEffect("docs"));
    expect(aborts).toBe(0);
    expect(disposals).toBe(2);
  });

  test("starts different Runtime Session creations in parallel", async () => {
    let started = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = makePiRuntime({
      createSessionEffect: () =>
        Effect.promise(async () => {
          started++;
          await barrier;
          return fakeSession();
        }),
    });
    const secondSession = {
      ...runtimeSession,
      id: "00000000-0000-4000-8000-000000000002",
      clientId: "other",
    };
    const first = Effect.runPromise(runtime.answerEffect(input("one")));
    const second = Effect.runPromise(
      runtime.answerEffect({
        workspace,
        session: secondSession,
        question: "two",
        signal: new AbortController().signal,
      }),
    );
    await sleep(0);

    expect(started).toBe(2);
    release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    await Effect.runPromise(runtime.disposeEffect());
  });

  test("reserves a Runtime slot before disposing its idle occupant", async () => {
    let creations = 0;
    let releaseDisposal!: () => void;
    let disposalStarted!: () => void;
    const disposalGate = new Promise<void>((resolve) => {
      releaseDisposal = resolve;
    });
    const started = new Promise<void>((resolve) => {
      disposalStarted = resolve;
    });
    const initial = fakeSession();
    initial.disposeEffect = () =>
      Effect.promise(async () => {
        disposalStarted();
        await disposalGate;
      });
    const runtime = makePiRuntime({
      maxRuntimes: 1,
      createSessionEffect: () =>
        Effect.promise(async () => {
          creations++;
          return creations === 1 ? initial : fakeSession();
        }),
    });
    await Effect.runPromise(runtime.answerEffect(input("initial")));
    const replacementSession = {
      ...runtimeSession,
      id: "00000000-0000-4000-8000-000000000002",
      clientId: "replacement",
    };
    const blockedSession = {
      ...runtimeSession,
      id: "00000000-0000-4000-8000-000000000003",
      clientId: "blocked",
    };

    const replacement = Effect.runPromise(
      runtime.answerEffect({
        workspace,
        session: replacementSession,
        question: "replacement",
        signal: new AbortController().signal,
      }),
    );
    await started;
    await expect(
      Effect.runPromise(
        runtime.answerEffect({
          workspace,
          session: blockedSession,
          question: "blocked",
          signal: new AbortController().signal,
        }),
      ),
    ).rejects.toMatchObject({ code: "BUSY" });
    expect(creations).toBe(1);

    releaseDisposal();
    await expect(replacement).resolves.toEqual({ answer: "answer" });
    expect(creations).toBe(2);
    await Effect.runPromise(runtime.disposeEffect());
  });

  test("fails shutdown within a bound when session creation never settles", async () => {
    const controller = new AbortController();
    let fatal: Error | undefined;
    const runtime = makePiRuntime({
      createSessionEffect: () => Effect.never,
      creationRetireTimeoutMs: 10,
      fatal: (error) => {
        fatal = error;
      },
    });
    const pending = Effect.runPromise(runtime.answerEffect(input("hello", controller.signal)));
    await sleep(0);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    await expect(Effect.runPromise(runtime.disposeEffect())).rejects.toThrow(
      "creation did not settle",
    );
    expect(fatal?.message).toContain("creation did not settle");
  });
});

function fakeSession(): PiRpcSessionEffect {
  return {
    promptEffect: () => Effect.void,
    isAlive: () => true,
    getLastAssistantText: () => "answer",
    clearQueueEffect: () => Effect.void,
    abortEffect: () => Effect.void,
    waitForIdleEffect: () => Effect.void,
    disposeEffect: () => Effect.void,
  };
}
