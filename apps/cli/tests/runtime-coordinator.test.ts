import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore, type WorkspaceConfig } from "../src/config";
import { QujingError } from "../src/errors";
import { RuntimeCoordinator } from "../src/runtime/coordinator";
import type { RuntimeNodeSession } from "../src/runtime/session";
import { RuntimeSessionStore, type RuntimeSession } from "../src/runtime/sessions";
import { makeRuntimePool } from "./helpers/runtime-pool";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AgentApplication } from "../src/agent-application";
import { createAgentMcp } from "../src/agent-mcp";
import { createMcpNode } from "../src/mcp";
import { PeerRuntime } from "../src/peer-runtime";
import { createQujing } from "../src/qujing";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(
  createSessionEffect: (
    workspace: WorkspaceConfig,
    session: RuntimeSession,
  ) => Effect.Effect<RuntimeNodeSession, unknown> = () => Effect.succeed(fakeSession()),
) {
  const root = await mkdtemp(join(tmpdir(), "qujing-coordinator-"));
  roots.push(root);
  const stateRoot = join(root, "state");
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);
  const config = new ConfigStore({
    configPath: join(root, "config.json"),
    stateRoot,
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
  const added = await Effect.runPromise(
    config.addAgentEffect({
      id: "agent",
      tailcatKey: "nodekey:first",
    }),
  );
  const agent = (await Effect.runPromise(config.authenticateEffect(added.bearer)))!;
  const sessions = new RuntimeSessionStore(stateRoot);
  const runtime = makeRuntimePool({
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
    agent,
    bearer: added.bearer,
  };
}

describe("RuntimeCoordinator", () => {
  test("preserves admission errors across both MCP hops without starting Runtime", async () => {
    let starts = 0;
    const { config, coordinator, bearer } = await fixture(() => {
      starts++;
      return Effect.succeed(fakeSession());
    });
    const node = createMcpNode({
      app: createQujing({ config, coordinator }),
      authenticateEffect: (token) => config.authenticateEffect(token),
      allowedHosts: ["127.0.0.1"],
      allowedOrigins: [],
    });
    const remote = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: node.fetch });
    const now = new Date().toISOString();
    const app = new AgentApplication({
      config: {
        readEffect: () =>
          Effect.succeed({
            version: 1,
            server: { host: "127.0.0.1", port: 43111 },
            localBearerHash: "a".repeat(64),
            peers: [
              {
                id: "peer",
                expectedNodeId: "node",
                remoteAgentId: "agent",
                serverAddress: "test",
                remotePort: remote.port!,
                keyPath: "/unused",
                remoteBearer: bearer,
                createdAt: now,
                updatedAt: now,
              },
            ],
          }),
      },
      createRuntime: (peer) =>
        new PeerRuntime({
          peer,
          startConnectorEffect: () =>
            Effect.succeed({
              ready: { ready: true, localAddress: `127.0.0.1:${remote.port}` },
              exitedEffect: Effect.never,
              closeEffect: () => Effect.void,
            }),
        }),
    });
    const mcp = createAgentMcp({
      app,
      config: {
        authenticateLocalEffect: () => Effect.succeed({ id: "local", credentialVersion: "v1" }),
      },
      allowedHosts: ["127.0.0.1"],
      allowedOrigins: [],
    });
    const local = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: mcp.fetch });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${local.port}/mcp`),
      {
        requestInit: { headers: { Authorization: "Bearer local" } },
      },
    );
    const client = new Client({ name: "test", version: "1" });
    try {
      await client.connect(transport as Parameters<Client["connect"]>[0]);
      for (const [question, code] of [
        ["hello", "WORKSPACE_NOT_FOUND"],
        ["", "INVALID_QUESTION"],
      ]) {
        const result = await client.callTool({
          name: "ask",
          arguments: { peer: "peer", workspace: "missing", question },
        });
        expect(result.isError).toBe(true);
        expect(result.content).toEqual([{ type: "text", text: `${code}: Remote request failed` }]);
      }
      expect(starts).toBe(0);
    } finally {
      await transport.terminateSession();
      await client.close();
      await Effect.runPromise(mcp.closeEffect);
      await Effect.runPromise(app.closeEffect());
      local.stop(true);
      await Effect.runPromise(node.closeEffect);
      remote.stop(true);
      await Effect.runPromise(coordinator.closeEffect());
    }
  });

  test("keeps one durable Runtime Session ID for a Peer and Workspace", async () => {
    const { coordinator, sessions, agent } = await fixture();
    const signal = new AbortController().signal;

    await Effect.runPromise(
      coordinator.answerEffect({
        peer: agent,
        workspaceId: "docs",
        question: "one",
        signal,
      }),
    );
    const first = (await Effect.runPromise(sessions.listEffect()))[0]!;
    await Effect.runPromise(
      coordinator.answerEffect({
        peer: agent,
        workspaceId: "docs",
        question: "two",
        signal,
      }),
    );

    expect((await Effect.runPromise(sessions.listEffect()))[0]?.id).toBe(first.id);
    await Effect.runPromise(coordinator.closeEffect());
  });

  test("validates questions after Agent admission and before Workspace admission", async () => {
    const { coordinator, agent } = await fixture();
    const signal = new AbortController().signal;

    await expect(
      Effect.runPromise(
        coordinator.answerEffect({
          peer: { id: "revoked", credentialVersion: "revoked" },
          workspaceId: "missing",
          question: "",
          signal,
        }),
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      Effect.runPromise(
        coordinator.answerEffect({
          peer: agent,
          workspaceId: "missing",
          question: "   ",
          signal,
        }),
      ),
    ).rejects.toEqual(new QujingError("INVALID_QUESTION", "Question must not be empty"));
    await expect(
      Effect.runPromise(
        coordinator.answerEffect({
          peer: agent,
          workspaceId: "docs",
          question: "x".repeat(20_001),
          signal,
        }),
      ),
    ).rejects.toEqual(
      new QujingError("INVALID_QUESTION", "Question must not exceed 20,000 characters"),
    );
    await expect(
      Effect.runPromise(
        coordinator.answerEffect({
          peer: agent,
          workspaceId: "missing",
          question: "hello",
          signal,
        }),
      ),
    ).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
    await Effect.runPromise(coordinator.closeEffect());
  });

  test("aborts revocation and removes binding without deleting backend state", async () => {
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
    const { root, coordinator, config, sessions, agent } = await fixture(() =>
      Effect.succeed(managed),
    );
    const pending = Effect.runPromise(
      coordinator.answerEffect({
        peer: agent,
        workspaceId: "docs",
        question: "running",
        signal: new AbortController().signal,
      }),
    );
    await started;
    const archive = join(root, "runtime-backend-state.jsonl");
    await writeFile(archive, "history");

    await Effect.runPromise(config.revokeAgentEffect("agent"));
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
          peer: agent,
          workspaceId: "docs",
          question: "late",
          signal: new AbortController().signal,
        }),
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await Effect.runPromise(coordinator.closeEffect());
  });

  test("waits for in-flight Runtime creation before removing a binding", async () => {
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
        peer: current.agent,
        workspaceId: "docs",
        question: "running",
        signal: new AbortController().signal,
      }),
    );
    await started;
    await Effect.runPromise(current.config.revokeAgentEffect("agent"));
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

  test("credential rotation restarts memory but preserves the Runtime Session ID", async () => {
    let creations = 0;
    const { coordinator, config, sessions, agent } = await fixture(() =>
      Effect.sync(() => {
        creations++;
        return fakeSession();
      }),
    );
    const input = {
      peer: agent,
      workspaceId: "docs",
      question: "one",
      signal: new AbortController().signal,
    };
    await Effect.runPromise(coordinator.answerEffect(input));
    const before = (await Effect.runPromise(sessions.listEffect()))[0]!;

    const rotated = await Effect.runPromise(config.rotateAgentEffect("agent", "nodekey:second"));
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
        peer: (await Effect.runPromise(config.authenticateEffect(rotated.bearer)))!,
        question: "two",
      }),
    );

    expect((await Effect.runPromise(sessions.listEffect()))[0]?.id).toBe(before.id);
    expect(creations).toBe(2);
    await Effect.runPromise(coordinator.closeEffect());
  });

  test("linearizes admission before credential rotation", async () => {
    const { coordinator, config, sessions, agent } = await fixture();
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
        peer: agent,
        workspaceId: "docs",
        question: "before rotation",
        signal: new AbortController().signal,
      }),
    );
    await admissionEntered;
    let rotated = false;
    const rotation = Effect.runPromise(config.rotateAgentEffect("agent", "nodekey:second")).then(
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
    const { root, coordinator, config, sessions, agent } = await fixture();
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
        peer: agent,
        workspaceId: "docs",
        question: "docs",
        signal,
      }),
    );
    await Effect.runPromise(
      coordinator.answerEffect({
        peer: agent,
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

  test("startup removes bindings for absent Peers and Workspaces", async () => {
    const initial = await fixture();
    const keep = await Effect.runPromise(initial.sessions.getOrCreateEffect("agent", "docs"));
    await Effect.runPromise(initial.sessions.getOrCreateEffect("revoked", "docs"));
    await Effect.runPromise(initial.sessions.getOrCreateEffect("agent", "removed"));
    await Effect.runPromise(initial.coordinator.closeEffect());
    const runtime = makeRuntimePool({ createSessionEffect: () => Effect.succeed(fakeSession()) });

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

  test("runtime backend change retires active sessions without deleting bindings", async () => {
    let disposals = 0;
    const session = fakeSession();
    session.disposeEffect = () =>
      Effect.sync(() => {
        disposals++;
      });
    const { coordinator, config, sessions, agent } = await fixture(() => Effect.succeed(session));
    const signal = new AbortController().signal;

    await Effect.runPromise(
      coordinator.answerEffect({ peer: agent, workspaceId: "docs", question: "one", signal }),
    );
    const binding = (await Effect.runPromise(sessions.listEffect()))[0]!;
    await Effect.runPromise(
      config.setRuntimeEffect({
        kind: "tanstack-acp",
        name: "codex",
        model: "test-model",
        command: "agent --acp --model {model} --cwd {cwd}",
      }),
    );
    await Effect.runPromise(
      coordinator.reconcileEffect(await Effect.runPromise(config.readEffectiveEffect())),
    );

    expect(disposals).toBe(1);
    expect((await Effect.runPromise(sessions.listEffect()))[0]?.id).toBe(binding.id);
    await Effect.runPromise(coordinator.closeEffect());
  });
});

function fakeSession(): RuntimeNodeSession {
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
