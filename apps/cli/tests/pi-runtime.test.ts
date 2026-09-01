import { describe, expect, test } from "bun:test";
import { PiRuntime, type ManagedPiSession } from "../src/runtime/pi-runtime";

const workspace = { id: "docs", name: "Docs", summary: "Docs", root: "/tmp/docs" };
const runtimeSession = {
  id: "00000000-0000-4000-8000-000000000001",
  clientId: "client",
  workspaceId: "docs",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function input(question: string, signal = new AbortController().signal) {
  return { workspace, session: runtimeSession, question, signal };
}

describe("PiRuntime", () => {
  test("serializes turns in one runtime session", async () => {
    let active = 0;
    let maximum = 0;
    let answer = "";
    const session: ManagedPiSession = {
      prompt: async (question) => {
        active++;
        maximum = Math.max(maximum, active);
        await Bun.sleep(10);
        answer = `answer:${question}`;
        active--;
      },
      isAlive: () => true,
      getLastAssistantText: () => answer,
      clearQueue: async () => {},
      abort: async () => {},
      waitForIdle: async () => {},
      dispose: async () => {},
    };
    const runtime = new PiRuntime({ createSession: async () => session });

    const results = await Promise.all([runtime.answer(input("one")), runtime.answer(input("two"))]);

    expect(maximum).toBe(1);
    expect(results).toEqual([{ answer: "answer:one" }, { answer: "answer:two" }]);
    await runtime.dispose();
  });

  test("clears queues and aborts Pi when caller cancels", async () => {
    const controller = new AbortController();
    let clearCount = 0;
    let abortCount = 0;
    let rejectPrompt: ((error: Error) => void) | undefined;
    const session = fakeSession();
    session.prompt = () =>
      new Promise<void>((_resolve, reject) => {
        rejectPrompt = reject;
      });
    session.clearQueue = async () => {
      clearCount++;
    };
    session.abort = async () => {
      abortCount++;
      rejectPrompt?.(new DOMException("Aborted", "AbortError"));
    };
    const runtime = new PiRuntime({ createSession: async () => session });
    const pending = runtime.answer(input("hello", controller.signal));
    await Bun.sleep(1);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(clearCount).toBe(1);
    expect(abortCount).toBe(1);
  });

  test("cannot return success when abort makes prompt resolve", async () => {
    const controller = new AbortController();
    let resolvePrompt: (() => void) | undefined;
    const session = fakeSession();
    session.prompt = () =>
      new Promise<void>((resolve) => {
        resolvePrompt = resolve;
      });
    session.abort = async () => {
      resolvePrompt?.();
    };
    const runtime = new PiRuntime({ createSession: async () => session });
    const pending = runtime.answer(input("hello", controller.signal));
    await Bun.sleep(1);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  test("fails fatally when Pi does not become idle after abort", async () => {
    const controller = new AbortController();
    let fatal: Error | undefined;
    const session = fakeSession();
    session.prompt = () => new Promise<void>(() => {});
    session.waitForIdle = () => new Promise<void>(() => {});
    const runtime = new PiRuntime({
      createSession: async () => session,
      abortTimeoutMs: 10,
      fatal: (error) => {
        fatal = error;
      },
    });
    const pending = runtime.answer(input("hello", controller.signal));
    await Bun.sleep(1);

    controller.abort();

    await expect(pending).rejects.toBeDefined();
    expect(fatal?.message).toContain("did not settle");
  });

  test("bounds the full clear, abort, and settlement sequence", async () => {
    const controller = new AbortController();
    let fatal: Error | undefined;
    const session = fakeSession();
    session.prompt = () => new Promise<void>(() => {});
    session.clearQueue = () => new Promise<void>(() => {});
    const runtime = new PiRuntime({
      createSession: async () => session,
      abortTimeoutMs: 10,
      fatal: (error) => {
        fatal = error;
      },
    });
    const pending = runtime.answer(input("hello", controller.signal));
    await Bun.sleep(1);

    controller.abort();

    await expect(pending).rejects.toBeDefined();
    expect(fatal?.message).toContain("did not settle");
    await runtime.dispose();
  });

  test("releases a Runtime slot after creation fails", async () => {
    let attempts = 0;
    const runtime = new PiRuntime({
      maxRuntimes: 1,
      createSession: async () => {
        attempts++;
        if (attempts === 1) throw new Error("startup failed");
        return fakeSession();
      },
    });

    await expect(runtime.answer(input("one"))).rejects.toMatchObject({
      code: "RUNTIME_UNAVAILABLE",
    });
    await expect(runtime.answer(input("two"))).resolves.toEqual({ answer: "answer" });
    await runtime.dispose();
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
    dead.prompt = async () => {
      firstStarted();
      await failureGate;
      alive = false;
      throw new Error("Pi exited");
    };
    dead.isAlive = () => alive;
    const runtime = new PiRuntime({
      maxRuntimes: 1,
      createSession: async () => {
        attempts++;
        return attempts === 1 ? dead : fakeSession();
      },
    });

    const first = runtime.answer(input("one"));
    await started;
    const queued = runtime.answer(input("two"));
    await Bun.sleep(0);
    failFirst();

    await expect(first).rejects.toMatchObject({ code: "RUNTIME_FAILED" });
    await expect(queued).resolves.toEqual({ answer: "answer" });
    expect(attempts).toBe(2);
    await runtime.dispose();
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
    session.prompt = async (question) => {
      if (question === "one") {
        firstStarted();
        await firstGate;
      }
      answer = question;
    };
    session.getLastAssistantText = () => answer;
    const timeoutControllers: AbortController[] = [];
    const runtime = new PiRuntime({
      createSession: async () => session,
      createTimeoutSignal: () => {
        const controller = new AbortController();
        timeoutControllers.push(controller);
        return controller.signal;
      },
    });

    const first = runtime.answer(input("one"));
    await started;
    const second = runtime.answer(input("two"));
    timeoutControllers[1]!.abort(new DOMException("Timed out", "TimeoutError"));
    await expect(second).rejects.toMatchObject({ code: "RUNTIME_TIMEOUT" });
    releaseFirst();
    await expect(first).resolves.toEqual({ answer: "one" });
    await runtime.dispose();
  });

  test("disposes active sessions by Client or Workspace", async () => {
    let aborts = 0;
    let disposals = 0;
    const session = fakeSession();
    session.abort = async () => {
      aborts++;
    };
    session.dispose = async () => {
      disposals++;
    };
    const runtime = new PiRuntime({ createSession: async () => session });
    await runtime.answer(input("hello"));

    await runtime.disposeClient("client");
    expect(aborts).toBe(0);
    expect(disposals).toBe(1);
    await runtime.answer(input("again"));
    await runtime.disposeWorkspace("docs");
    expect(aborts).toBe(0);
    expect(disposals).toBe(2);
  });

  test("starts different Runtime Session creations in parallel", async () => {
    let started = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = new PiRuntime({
      createSession: async () => {
        started++;
        await barrier;
        return fakeSession();
      },
    });
    const secondSession = {
      ...runtimeSession,
      id: "00000000-0000-4000-8000-000000000002",
      clientId: "other",
    };
    const first = runtime.answer(input("one"));
    const second = runtime.answer({
      workspace,
      session: secondSession,
      question: "two",
      signal: new AbortController().signal,
    });
    await Bun.sleep(0);

    expect(started).toBe(2);
    release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    await runtime.dispose();
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
    initial.dispose = async () => {
      disposalStarted();
      await disposalGate;
    };
    const runtime = new PiRuntime({
      maxRuntimes: 1,
      createSession: async () => {
        creations++;
        return creations === 1 ? initial : fakeSession();
      },
    });
    await runtime.answer(input("initial"));
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

    const replacement = runtime.answer({
      workspace,
      session: replacementSession,
      question: "replacement",
      signal: new AbortController().signal,
    });
    await started;
    await expect(
      runtime.answer({
        workspace,
        session: blockedSession,
        question: "blocked",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "BUSY" });
    expect(creations).toBe(1);

    releaseDisposal();
    await expect(replacement).resolves.toEqual({ answer: "answer" });
    expect(creations).toBe(2);
    await runtime.dispose();
  });

  test("fails shutdown within a bound when session creation never settles", async () => {
    const controller = new AbortController();
    let fatal: Error | undefined;
    const runtime = new PiRuntime({
      createSession: () => new Promise<ManagedPiSession>(() => {}),
      creationRetireTimeoutMs: 10,
      fatal: (error) => {
        fatal = error;
      },
    });
    const pending = runtime.answer(input("hello", controller.signal));
    await Bun.sleep(0);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    await expect(runtime.dispose()).rejects.toThrow("creation did not settle");
    expect(fatal?.message).toContain("creation did not settle");
  });
});

function fakeSession(): ManagedPiSession {
  return {
    prompt: async () => {},
    isAlive: () => true,
    getLastAssistantText: () => "answer",
    clearQueue: async () => {},
    abort: async () => {},
    waitForIdle: async () => {},
    dispose: async () => {},
  };
}
