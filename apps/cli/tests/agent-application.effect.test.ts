import { expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber } from "effect";
import { AgentApplication } from "../src/agent-application";
import type { AgentConfig, PeerConfig } from "../src/agent-config";
import { PeerRuntime } from "../src/peer-runtime";

const now = new Date().toISOString();
const peer: PeerConfig = {
  id: "one",
  expectedNodeId: "node-one",
  remoteAgentId: "one",
  serverAddress: "one",
  remotePort: 1,
  keyPath: "/one",
  remoteBearer: "one",
  createdAt: now,
  updatedAt: now,
};
const config: AgentConfig = {
  version: 1,
  server: { host: "127.0.0.1", port: 1 },
  localBearerHash: "a".repeat(64),
  peers: [peer],
};

const waitUntil = (condition: () => boolean): Effect.Effect<void> =>
  Effect.suspend(() =>
    condition()
      ? Effect.void
      : Effect.sleep(Duration.millis(5)).pipe(Effect.andThen(waitUntil(condition))),
  );

it.live("runs AgentApplication Effect API", () =>
  Effect.gen(function* () {
    const app = new AgentApplication({
      config: {
        readEffect: () => Effect.succeed(config),
      },
      createRuntime: () => ({
        listWorkspacesEffect: () =>
          Effect.succeed({ node: { id: "node-one", name: "One" }, workspaces: [] }),
        askEffect: (workspace, question) => Effect.succeed({ workspace, answer: question }),
        closeEffect: () => Effect.void,
      }),
    });
    expect(yield* app.listPeersEffect()).toMatchObject([{ id: "one", available: true }]);
    expect(yield* app.askEffect({ peer: "one", workspace: "docs", question: "hi" })).toEqual({
      peer: "one",
      workspace: "docs",
      answer: "hi",
    });
    yield* app.closeEffect();
  }),
);

it.live("waits for aborted upstream call before retiring runtime lease", () =>
  Effect.gen(function* () {
    let abortSeen = false;
    let closed = false;
    let resolveAsk!: (result: Record<string, unknown>) => void;
    const events: string[] = [];
    const runtime = new PeerRuntime({
      peer,
      startConnectorEffect: () =>
        Effect.succeed({
          ready: { ready: true, localAddress: "127.0.0.1:4567" },
          exitedEffect: Effect.never,
          closeEffect: () => Effect.sync(() => events.push("connector-close")),
        }),
      createUpstream: () => ({
        transport: {
          terminateSession: async () => {
            events.push("terminate");
          },
        },
        agent: {
          connect: async () => {},
          callTool: ({ name }, _schema, options) => {
            if (name === "list_workspaces")
              return Promise.resolve({
                structuredContent: { node: { id: "node-one", name: "One" }, workspaces: [] },
              });
            return new Promise((resolve) => {
              resolveAsk = resolve;
              options?.signal?.addEventListener(
                "abort",
                () => {
                  abortSeen = true;
                },
                { once: true },
              );
            });
          },
          close: async () => {
            events.push("agent-close");
          },
        },
      }),
    });
    const app = new AgentApplication({
      config: { readEffect: () => Effect.succeed(config) },
      createRuntime: () => runtime,
    });
    const request = yield* app
      .askEffect({ peer: "one", workspace: "docs", question: "hi" })
      .pipe(Effect.forkChild);
    yield* waitUntil(() => !!resolveAsk);
    const interrupted = yield* Fiber.interrupt(request).pipe(Effect.forkChild);
    yield* waitUntil(() => abortSeen);
    const closing = yield* app.closeEffect().pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          closed = true;
        }),
      ),
      Effect.forkChild,
    );
    yield* Effect.sleep(Duration.millis(20));
    expect(closed).toBe(false);
    expect(events).toEqual([]);
    resolveAsk({ structuredContent: { workspace: "docs", answer: "late" } });
    yield* Fiber.await(interrupted);
    yield* Fiber.join(closing);
    expect(events).toEqual(["terminate", "agent-close", "connector-close"]);
  }),
);
