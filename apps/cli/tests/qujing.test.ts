import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQujing } from "../src/qujing";
import { ConfigStore } from "../src/config";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "qujing-core-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);
  const config = new ConfigStore({
    configPath: join(root, "config.json"),
    stateRoot: join(root, "state"),
  });
  await Effect.runPromise(config.initEffect({ node: { id: "node", name: "Node" } }));
  await Effect.runPromise(
    config.addWorkspaceEffect({
      id: "docs",
      name: "Docs",
      summary: "Product docs",
      root: workspaceRoot,
    }),
  );
  const first = await Effect.runPromise(
    config.addAgentEffect({
      id: "first",
      tailcatKey: "first-key",
    }),
  );
  const second = await Effect.runPromise(
    config.addAgentEffect({
      id: "second",
      tailcatKey: "second-key",
    }),
  );
  const calls: Array<{ peer: string; workspace: string; question: string }> = [];
  const signals: AbortSignal[] = [];
  const app = createQujing({
    config,
    coordinator: {
      answerEffect: ({ peer, workspaceId, question, signal }) =>
        Effect.sync(() => {
          calls.push({ peer: peer.id, workspace: workspaceId, question });
          signals.push(signal);
          return `answer:${question}`;
        }),
    },
  });
  return {
    app,
    calls,
    signals,
    first: (await Effect.runPromise(config.authenticateEffect(first.bearer)))!,
    second: (await Effect.runPromise(config.authenticateEffect(second.bearer)))!,
  };
}

describe("Qujing core", () => {
  test("lists only public node and workspace metadata for active peers", async () => {
    const { app, first } = await fixture();

    expect(await Effect.runPromise(app.listWorkspacesEffect(first))).toEqual({
      node: { id: "node", name: "Node" },
      workspaces: [{ id: "docs", name: "Docs", summary: "Product docs", available: true }],
    });
    await expect(
      Effect.runPromise(app.listWorkspacesEffect({ id: "revoked", credentialVersion: "revoked" })),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  test("passes authenticated Agent and selected Workspace to runtime coordination", async () => {
    const { app, calls, signals, first, second } = await fixture();
    const firstSignal = new AbortController().signal;

    await Effect.runPromise(
      app.askEffect({ peer: first, workspace: "docs", question: "one" }, firstSignal),
    );
    await Effect.runPromise(
      app.askEffect(
        { peer: first, workspace: "docs", question: "two" },
        new AbortController().signal,
      ),
    );
    await Effect.runPromise(
      app.askEffect(
        { peer: second, workspace: "docs", question: "three" },
        new AbortController().signal,
      ),
    );

    expect(calls).toEqual([
      { peer: "first", workspace: "docs", question: "one" },
      { peer: "first", workspace: "docs", question: "two" },
      { peer: "second", workspace: "docs", question: "three" },
    ]);
    expect(signals[0]).toBe(firstSignal);
    expect(signals).toHaveLength(3);
  });

  test("linearizes Agent authorization with the Workspace metadata snapshot", async () => {
    let releaseSnapshot!: () => void;
    let snapshotReached!: () => void;
    let revokeLockAttempted!: () => void;
    const snapshotRelease = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      snapshotReached = resolve;
    });
    const revokeAttempted = new Promise<void>((resolve) => {
      revokeLockAttempted = resolve;
    });
    class PausableConfigStore extends ConfigStore {
      pause = false;
      onLockAttempt: (() => void) | undefined;

      override readEffectiveEffect() {
        return super
          .readEffectiveEffect()
          .pipe(
            Effect.tap(() =>
              this.pause
                ? Effect.sync(snapshotReached).pipe(
                    Effect.andThen(Effect.promise(() => snapshotRelease)),
                  )
                : Effect.void,
            ),
          );
      }

      override withLockEffect<A>(operation: Effect.Effect<A, unknown>) {
        this.onLockAttempt?.();
        return super.withLockEffect(operation);
      }
    }

    const root = await mkdtemp(join(tmpdir(), "qujing-list-revoke-"));
    roots.push(root);
    const workspaceRoot = join(root, "workspace");
    await mkdir(workspaceRoot);
    const config = new PausableConfigStore({
      configPath: join(root, "config.json"),
      stateRoot: join(root, "state"),
    });
    await Effect.runPromise(config.initEffect({ node: { id: "node", name: "Node" } }));
    await Effect.runPromise(
      config.addWorkspaceEffect({
        id: "docs",
        name: "Docs",
        summary: "Docs",
        root: workspaceRoot,
      }),
    );
    const { bearer } = await Effect.runPromise(
      config.addAgentEffect({ id: "agent", tailcatKey: "nodekey:test" }),
    );
    const agent = (await Effect.runPromise(config.authenticateEffect(bearer)))!;
    const app = createQujing({
      config,
      coordinator: { answerEffect: () => Effect.succeed("unused") },
    });

    config.pause = true;
    const listing = Effect.runPromise(app.listWorkspacesEffect(agent));
    await reached;
    config.onLockAttempt = revokeLockAttempted;
    let revoked = false;
    const revoking = Effect.runPromise(config.revokeAgentEffect("agent")).then((result) => {
      revoked = true;
      return result;
    });
    await revokeAttempted;
    expect(revoked).toBe(false);
    releaseSnapshot();

    expect((await listing).workspaces).toHaveLength(1);
    expect(await revoking).toBe(true);
  });
});
