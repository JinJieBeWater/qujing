import { expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../src/config";
import type { RuntimeAgentSession } from "../src/runtime/session";
import { RuntimeCoordinator } from "../src/runtime/coordinator";
import { RuntimeSessionStore } from "../src/runtime/sessions";
import { makeRuntimePool } from "./helpers/runtime-pool";

it.live("runs RuntimeCoordinator Effect API", () =>
  Effect.gen(function* () {
    const root = yield* node(() => mkdtemp(join(tmpdir(), "qujing-coordinator-effect-")));
    const workspace = join(root, "workspace");
    const config = new ConfigStore({
      configPath: join(root, "config.json"),
      stateRoot: join(root, "state"),
    });
    const sessions = new RuntimeSessionStore(join(root, "state"));
    const runtime = makeRuntimePool({ createSessionEffect: () => Effect.succeed(fakeSession()) });
    yield* Effect.ensuring(
      Effect.gen(function* () {
        yield* node(() => mkdir(workspace));
        yield* config.initEffect({ owner: { id: "owner", name: "Owner" } });
        yield* config.addWorkspaceEffect({
          id: "docs",
          name: "Docs",
          summary: "Docs",
          root: workspace,
        });
        const { bearer } = yield* config.addClientEffect({
          id: "client",
          tailcatKey: "nodekey:test",
        });
        const client = yield* config.authenticateEffect(bearer);
        const coordinator = yield* RuntimeCoordinator.createEffect({
          config,
          sessions,
          runtime,
          desired: yield* config.readEffectiveEffect(),
        });
        expect(client).toBeDefined();
        expect(
          yield* coordinator.answerEffect({
            client: client!,
            workspaceId: "docs",
            question: "hello",
            signal: new AbortController().signal,
          }),
        ).toBe("answer");
        yield* coordinator.closeEffect();
      }),
      node(() => rm(root, { recursive: true, force: true })).pipe(Effect.orDie),
    );
  }),
);

it.live("disposes RuntimePool when coordinator acquisition fails", () =>
  Effect.gen(function* () {
    let disposed = false;
    const runtime = makeRuntimePool({ createSessionEffect: () => Effect.succeed(fakeSession()) });
    const dispose = runtime.disposeEffect.bind(runtime);
    runtime.disposeEffect = () =>
      dispose().pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            disposed = true;
          }),
        ),
      );
    const exit = yield* Effect.exit(
      RuntimeCoordinator.createEffect({
        config: {} as ConfigStore,
        sessions: {
          matchingEffect: () => Effect.fail(new Error("binding scan failed")),
        } as unknown as RuntimeSessionStore,
        runtime,
        desired: {
          version: 1,
          owner: { id: "owner", name: "Owner" },
          server: { host: "127.0.0.1", port: 43110 },
          workspaces: [],
          clients: [],
        },
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(disposed).toBe(true);
  }),
);

function node<A>(try_: () => Promise<A>) {
  return Effect.tryPromise({ try: try_, catch: (error) => error });
}

function fakeSession(): RuntimeAgentSession {
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
