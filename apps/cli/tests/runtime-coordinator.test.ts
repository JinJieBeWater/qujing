import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore, type WorkspaceConfig } from "../src/config";
import { ColleagueLineError } from "../src/errors";
import { RuntimeCoordinator } from "../src/runtime/coordinator";
import type { PiRpcSessionEffect } from "../src/runtime/pi-rpc";
import { RuntimeSessionStore, type RuntimeSession } from "../src/runtime/sessions";
import { makePiRuntime } from "./helpers/pi-runtime";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(
  createSessionEffect: (
    workspace: WorkspaceConfig,
    session: RuntimeSession,
  ) => Effect.Effect<PiRpcSessionEffect, unknown> = () => Effect.succeed(fakeSession()),
) {
  const root = await mkdtemp(join(tmpdir(), "colleague-line-coordinator-"));
  roots.push(root);
  const stateRoot = join(root, "state");
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);
  const config = new ConfigStore({
    configPath: join(root, "config.json"),
    stateRoot,
  });
  await Effect.runPromise(config.initEffect({ owner: { id: "owner", name: "Owner" } }));
  await Effect.runPromise(
    config.addWorkspaceEffect({
      id: "docs",
      name: "Docs",
      summary: "Docs",
      root: workspaceRoot,
    }),
  );
  const added = await Effect.runPromise(
    config.addClientEffect({
      id: "client",
      tailcatKey: "nodekey:first",
    }),
  );
  const client = (await Effect.runPromise(config.authenticateEffect(added.bearer)))!;
  const sessions = new RuntimeSessionStore(stateRoot);
  const runtime = makePiRuntime({
    createSessionEffect: (workspace, session) => createSessionEffect(workspace, session),
  });
  const desired = await Effect.runPromise(config.readEffectiveEffect());
  const coordinator = await Effect.runPromise(
    RuntimeCoordinator.createEffect({
      config,
      sessions,
      runtime,
      desired,
    }),
  );
  return {
    root,
    stateRoot,
    config,
    sessions,
    runtime,
    coordinator,
    desired,
    client,
  };
}

describe("RuntimeCoordinator", () => {
  test("keeps one durable Pi session ID for a Client and Workspace", async () => {
    const { coordinator, sessions, client } = await fixture();
    const signal = new AbortController().signal;

    await Effect.runPromise(
      coordinator.answerEffect({
        client,
        workspaceId: "docs",
        question: "one",
        signal,
      }),
    );
    const first = (await Effect.runPromise(sessions.listEffect()))[0]!;
    await Effect.runPromise(
      coordinator.answerEffect({
        client,
        workspaceId: "docs",
        question: "two",
        signal,
      }),
    );

    expect((await Effect.runPromise(sessions.listEffect()))[0]?.id).toBe(first.id);
    await Effect.runPromise(coordinator.closeEffect());
  });

  test("validates questions after Client admission and before Workspace admission", async () => {
    const { coordinator, client } = await fixture();
    const signal = new AbortController().signal;

    await expect(
      Effect.runPromise(
        coordinator.answerEffect({
          client: { id: "revoked", credentialVersion: "revoked" },
          workspaceId: "missing",
          question: "",
          signal,
        }),
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      Effect.runPromise(
        coordinator.answerEffect({
          client,
          workspaceId: "missing",
          question: "   ",
          signal,
        }),
      ),
    ).rejects.toEqual(new ColleagueLineError("INVALID_QUESTION", "Question must not be empty"));
    await expect(
      Effect.runPromise(
        coordinator.answerEffect({
          client,
          workspaceId: "docs",
          question: "x".repeat(20_001),
          signal,
        }),
      ),
    ).rejects.toEqual(
      new ColleagueLineError("INVALID_QUESTION", "Question must not exceed 20,000 characters"),
    );
    await expect(
      Effect.runPromise(
        coordinator.answerEffect({
          client,
          workspaceId: "missing",
          question: "hello",
          signal,
        }),
      ),
    ).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
    await Effect.runPromise(coordinator.closeEffect());
  });

  test("aborts revocation and removes binding without deleting Pi archive", async () => {
    let rejectPrompt: ((error: Error) => void) | undefined;
    let promptStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      promptStarted = resolve;
    });
    const managed = fakeSession();
    managed.promptEffect = () => {
      promptStarted();
      return Effect.tryPromise({
        try: () =>
          new Promise<void>((_resolve, reject) => {
            rejectPrompt = reject;
          }),
        catch: (error) => error as Error,
      });
    };
    managed.abortEffect = () =>
      Effect.promise(async () => {
        rejectPrompt?.(new DOMException("Aborted", "AbortError"));
      });
    const { root, coordinator, config, sessions, client } = await fixture(() =>
      Effect.succeed(managed),
    );
    const pending = Effect.runPromise(
      coordinator.answerEffect({
        client,
        workspaceId: "docs",
        question: "running",
        signal: new AbortController().signal,
      }),
    );
    await started;
    const archive = join(root, "owner-global-pi-session.jsonl");
    await writeFile(archive, "history");

    await Effect.runPromise(config.revokeClientEffect("client"));
    const reconciliation = Effect.runPromise(
      coordinator.reconcileEffect(await Effect.runPromise(config.readEffectiveEffect())),
    );
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await reconciliation;

    expect(await Effect.runPromise(sessions.listEffect())).toEqual([]);
    expect(await Bun.file(archive).text()).toBe("history");
    await expect(
      Effect.runPromise(
        coordinator.answerEffect({
          client,
          workspaceId: "docs",
          question: "late",
          signal: new AbortController().signal,
        }),
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await Effect.runPromise(coordinator.closeEffect());
  });

  test("waits for in-flight Pi creation before removing a binding", async () => {
    let releaseCreation!: () => void;
    const creationBarrier = new Promise<void>((resolve) => {
      releaseCreation = resolve;
    });
    let creationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      creationStarted = resolve;
    });
    let disposals = 0;
    const current = await fixture(() =>
      Effect.promise(async () => {
        creationStarted();
        await creationBarrier;
        const managed = fakeSession();
        managed.disposeEffect = () =>
          Effect.promise(async () => {
            disposals++;
          });
        return managed;
      }),
    );
    const pending = Effect.runPromise(
      current.coordinator.answerEffect({
        client: current.client,
        workspaceId: "docs",
        question: "running",
        signal: new AbortController().signal,
      }),
    );
    await started;
    await Effect.runPromise(current.config.revokeClientEffect("client"));
    let reconciled = false;
    const reconciliation = Effect.runPromise(
      current.coordinator.reconcileEffect(
        await Effect.runPromise(current.config.readEffectiveEffect()),
      ),
    ).then(() => {
      reconciled = true;
    });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await Bun.sleep(0);
    expect(reconciled).toBe(false);

    releaseCreation();
    await reconciliation;
    expect(disposals).toBe(1);
    expect(await Effect.runPromise(current.sessions.listEffect())).toEqual([]);
    await Effect.runPromise(current.coordinator.closeEffect());
  });

  test("credential rotation restarts memory but preserves the Pi session ID", async () => {
    let creations = 0;
    const { coordinator, config, sessions, client } = await fixture(() =>
      Effect.sync(() => {
        creations++;
        return fakeSession();
      }),
    );
    const input = {
      client,
      workspaceId: "docs",
      question: "one",
      signal: new AbortController().signal,
    };
    await Effect.runPromise(coordinator.answerEffect(input));
    const before = (await Effect.runPromise(sessions.listEffect()))[0]!;

    const rotated = await Effect.runPromise(config.rotateClientEffect("client", "nodekey:second"));
    await Effect.runPromise(
      coordinator.reconcileEffect(await Effect.runPromise(config.readEffectiveEffect())),
    );
    await expect(
      Effect.runPromise(coordinator.answerEffect({ ...input, question: "old" })),
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await Effect.runPromise(
      coordinator.answerEffect({
        ...input,
        client: (await Effect.runPromise(config.authenticateEffect(rotated.bearer)))!,
        question: "two",
      }),
    );

    expect((await Effect.runPromise(sessions.listEffect()))[0]?.id).toBe(before.id);
    expect(creations).toBe(2);
    await Effect.runPromise(coordinator.closeEffect());
  });

  test("linearizes admission before credential rotation", async () => {
    const { coordinator, config, sessions, client } = await fixture();
    const originalGetOrCreateEffect = sessions.getOrCreateEffect.bind(sessions);
    let entered!: () => void;
    const admissionEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const admissionBarrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    sessions.getOrCreateEffect = (...arguments_) =>
      Effect.gen(function* () {
        const session = yield* originalGetOrCreateEffect(...arguments_);
        entered();
        yield* Effect.promise(() => admissionBarrier);
        return session;
      });
    const admitted = Effect.runPromise(
      coordinator.answerEffect({
        client,
        workspaceId: "docs",
        question: "before rotation",
        signal: new AbortController().signal,
      }),
    );
    await admissionEntered;
    let rotated = false;
    const rotation = Effect.runPromise(config.rotateClientEffect("client", "nodekey:second")).then(
      () => {
        rotated = true;
      },
    );
    await Bun.sleep(10);
    expect(rotated).toBe(false);

    release();
    await admitted;
    await rotation;
    expect(rotated).toBe(true);
    await Effect.runPromise(coordinator.closeEffect());
  });

  test("Workspace removal purges only that binding scope", async () => {
    const { root, coordinator, config, sessions, client } = await fixture();
    const codeRoot = join(root, "code");
    await mkdir(codeRoot);
    await Effect.runPromise(
      config.addWorkspaceEffect({
        id: "code",
        name: "Code",
        summary: "Code",
        root: codeRoot,
      }),
    );
    await Effect.runPromise(
      coordinator.reconcileEffect(await Effect.runPromise(config.readEffectiveEffect())),
    );
    const signal = new AbortController().signal;
    await Effect.runPromise(
      coordinator.answerEffect({
        client,
        workspaceId: "docs",
        question: "docs",
        signal,
      }),
    );
    await Effect.runPromise(
      coordinator.answerEffect({
        client,
        workspaceId: "code",
        question: "code",
        signal,
      }),
    );
    const codeSession = (await Effect.runPromise(sessions.listEffect())).find(
      (session) => session.workspaceId === "code",
    )!;

    await Effect.runPromise(config.removeWorkspaceEffect("docs"));
    await Effect.runPromise(
      coordinator.reconcileEffect(await Effect.runPromise(config.readEffectiveEffect())),
    );

    expect(await Effect.runPromise(sessions.listEffect())).toEqual([codeSession]);
    await Effect.runPromise(coordinator.closeEffect());
  });

  test("startup removes bindings for absent Clients and Workspaces", async () => {
    const initial = await fixture();
    const keep = await Effect.runPromise(initial.sessions.getOrCreateEffect("client", "docs"));
    await Effect.runPromise(initial.sessions.getOrCreateEffect("revoked", "docs"));
    await Effect.runPromise(initial.sessions.getOrCreateEffect("client", "removed"));
    await Effect.runPromise(initial.coordinator.closeEffect());
    const runtime = makePiRuntime({ createSessionEffect: () => Effect.succeed(fakeSession()) });

    const coordinator = await Effect.runPromise(
      RuntimeCoordinator.createEffect({
        config: initial.config,
        sessions: initial.sessions,
        runtime,
        desired: await Effect.runPromise(initial.config.readEffectiveEffect()),
      }),
    );

    expect((await Effect.runPromise(initial.sessions.listEffect())).map(({ id }) => id)).toEqual([
      keep.id,
    ]);
    await Effect.runPromise(coordinator.closeEffect());
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
