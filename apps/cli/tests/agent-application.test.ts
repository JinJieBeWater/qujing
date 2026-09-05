import { expect, test } from "bun:test";
import { Effect } from "effect";
import { AgentApplication, peerFingerprint, type PeerRuntimeAgent } from "../src/agent-application";
import type { AgentConfig, PeerConfig } from "../src/agent-config";

const now = new Date().toISOString();
const peer = (id: string): PeerConfig => ({
  id,
  expectedNodeId: `node-${id}`,
  remoteAgentId: id,
  serverAddress: id,
  remotePort: 1,
  keyPath: `/${id}`,
  remoteBearer: id,
  createdAt: now,
  updatedAt: now,
});

function runtime(
  listWorkspacesEffect: PeerRuntimeAgent["listWorkspacesEffect"],
  askEffect: PeerRuntimeAgent["askEffect"] = (workspace, question) =>
    Effect.succeed({ workspace, answer: question }),
) {
  return { listWorkspacesEffect, askEffect, closeEffect: () => Effect.void };
}

test("aggregates Peers in config order and isolates unavailable Peer", async () => {
  const config: AgentConfig = {
    version: 1,
    server: { host: "127.0.0.1", port: 1 },
    localBearerHash: "a".repeat(64),
    peers: [peer("one"), peer("two")],
  };
  const app = new AgentApplication({
    config: { readEffect: () => Effect.succeed(config) },
    createRuntime: (entry) =>
      runtime(() =>
        entry.id === "one"
          ? Effect.succeed({ node: { id: "node-one", name: "One" }, workspaces: [] })
          : Effect.fail(new Error("private")),
      ),
  });
  expect(await Effect.runPromise(app.listPeersEffect())).toEqual([
    { id: "one", available: true, node: { id: "node-one", name: "One" }, workspaces: [] },
    { id: "two", available: false, workspaces: [] },
  ]);
});

test("routes ask to exact Peer and closes only changed runtime", async () => {
  const first = peer("one");
  const second = peer("two");
  let config: AgentConfig = {
    version: 1,
    server: { host: "127.0.0.1", port: 1 },
    localBearerHash: "a".repeat(64),
    peers: [first, second],
  };
  const calls: string[] = [];
  const closed: string[] = [];
  const app = new AgentApplication({
    config: { readEffect: () => Effect.succeed(config) },
    createRuntime: (entry) =>
      ({
        listWorkspacesEffect: () =>
          Effect.succeed({ node: { id: entry.expectedNodeId, name: entry.id }, workspaces: [] }),
        askEffect: (workspace, question) =>
          Effect.sync(() => {
            calls.push(entry.id);
            return { workspace, answer: question };
          }),
        closeEffect: () => Effect.sync(() => closed.push(entry.id)),
      }) as PeerRuntimeAgent,
  });
  expect(
    await Effect.runPromise(app.askEffect({ peer: "two", workspace: "w", question: "q" })),
  ).toEqual({
    peer: "two",
    workspace: "w",
    answer: "q",
  });
  expect(calls).toEqual(["two"]);
  config = { ...config, peers: [{ ...first, remoteBearer: "new" }, second] };
  await Effect.runPromise(app.reconcileEffect());
  expect(closed).toEqual([]);
  await Effect.runPromise(app.listPeersEffect());
  config = { ...config, peers: [{ ...config.peers[0]!, remoteBearer: "newer" }, second] };
  await Effect.runPromise(app.reconcileEffect());
  expect(closed).toEqual(["one"]);
});

test("cancellation reaches every Peer", async () => {
  const config: AgentConfig = {
    version: 1,
    server: { host: "127.0.0.1", port: 1 },
    localBearerHash: "a".repeat(64),
    peers: [peer("one"), peer("two")],
  };
  let aborted = 0;
  const app = new AgentApplication({
    config: { readEffect: () => Effect.succeed(config) },
    createRuntime: () =>
      runtime((signal) =>
        Effect.tryPromise({
          try: () =>
            new Promise((_resolve, reject) =>
              signal?.addEventListener(
                "abort",
                () => {
                  aborted++;
                  reject(new DOMException("Aborted", "AbortError"));
                },
                { once: true },
              ),
            ),
          catch: (error) => error,
        }),
      ),
  });
  const controller = new AbortController();
  const pending = Effect.runPromise(app.listPeersEffect(controller.signal));
  await Bun.sleep(1);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(aborted).toBe(2);
});

test("serializes config snapshots so stale runtimes cannot survive reconciliation", async () => {
  const oldPeer = peer("one");
  const newPeer = { ...oldPeer, remoteBearer: "new" };
  let releaseFirst!: () => void;
  let reads = 0;
  const closed: string[] = [];
  const app = new AgentApplication({
    config: {
      readEffect: () =>
        Effect.tryPromise({
          try: async () => {
            reads++;
            if (reads === 1)
              await new Promise<void>((resolve) => {
                releaseFirst = resolve;
              });
            return {
              version: 1,
              server: { host: "127.0.0.1", port: 1 },
              localBearerHash: "a".repeat(64),
              peers: [reads === 1 ? oldPeer : newPeer],
            };
          },
          catch: (error) => error,
        }),
    },
    createRuntime: (entry) =>
      ({
        listWorkspacesEffect: () =>
          Effect.succeed({
            node: { id: entry.expectedNodeId, name: entry.remoteBearer },
            workspaces: [],
          }),
        askEffect: (workspace, question) => Effect.succeed({ workspace, answer: question }),
        closeEffect: () => Effect.sync(() => closed.push(entry.remoteBearer)),
      }) satisfies PeerRuntimeAgent,
  });

  const oldRequest = Effect.runPromise(app.listPeersEffect());
  while (!releaseFirst) await Bun.sleep(1);
  const reconcile = Effect.runPromise(app.reconcileEffect());
  releaseFirst();
  await oldRequest;
  await reconcile;
  expect(closed).toEqual(["one"]);
  expect((await Effect.runPromise(app.listPeersEffect()))[0]?.node?.name).toBe("new");
  await Effect.runPromise(app.closeEffect());
});

test("close is terminal and catches a concurrent runtime acquisition", async () => {
  const config: AgentConfig = {
    version: 1,
    server: { host: "127.0.0.1", port: 1 },
    localBearerHash: "a".repeat(64),
    peers: [peer("one")],
  };
  let closed = 0;
  const app = new AgentApplication({
    config: { readEffect: () => Effect.succeed(config) },
    createRuntime: () =>
      ({
        listWorkspacesEffect: () =>
          Effect.succeed({ node: { id: "node-one", name: "One" }, workspaces: [] }),
        askEffect: (workspace, question) => Effect.succeed({ workspace, answer: question }),
        closeEffect: () => Effect.sync(() => closed++),
      }) satisfies PeerRuntimeAgent,
  });

  await Effect.runPromise(app.listPeersEffect());
  await Effect.runPromise(app.closeEffect());
  expect(closed).toBe(1);
  await expect(Effect.runPromise(app.listPeersEffect())).rejects.toMatchObject({
    code: "PEER_UNAVAILABLE",
  });
});

test("retires one Peer only after active work settles and blocks old credentials", async () => {
  const oldPeer = peer("one");
  let config: AgentConfig = {
    version: 1,
    server: { host: "127.0.0.1", port: 1 },
    localBearerHash: "a".repeat(64),
    peers: [oldPeer],
  };
  let started!: () => void;
  const active = new Promise<void>((resolve) => {
    started = resolve;
  });
  const retirementEvents: string[] = [];
  const app = new AgentApplication({
    config: { readEffect: () => Effect.succeed(config) },
    createRuntime: () => ({
      listWorkspacesEffect: () =>
        Effect.succeed({ node: { id: "node-one", name: "One" }, workspaces: [] }),
      askEffect: (_workspace, _question, signal) =>
        Effect.tryPromise({
          try: () => {
            started();
            return new Promise((_resolve, reject) =>
              signal?.addEventListener(
                "abort",
                async () => {
                  await Bun.sleep(10);
                  retirementEvents.push("settled");
                  reject(signal.reason);
                },
                { once: true },
              ),
            );
          },
          catch: (error) => error,
        }),
      closeEffect: () => Effect.sync(() => retirementEvents.push("closed")),
    }),
  });
  const pending = Effect.runPromise(
    app.askEffect({ peer: "one", workspace: "docs", question: "wait" }),
  );
  await active;
  await Effect.runPromise(app.retirePeerEffect(oldPeer.id, peerFingerprint(oldPeer)));
  expect(retirementEvents).toEqual(["settled", "closed"]);
  await expect(pending).rejects.toMatchObject({ code: "PEER_UNAVAILABLE" });
  await expect(
    Effect.runPromise(app.askEffect({ peer: "one", workspace: "docs", question: "blocked" })),
  ).rejects.toMatchObject({ code: "PEER_UNAVAILABLE" });

  config = { ...config, peers: [{ ...oldPeer, remoteBearer: "new" }] };
  await Effect.runPromise(app.reconcileEffect());
  expect((await Effect.runPromise(app.listPeersEffect()))[0]?.available).toBe(true);
  await Effect.runPromise(app.closeEffect());
});

test("does not complete Peer retirement when runtime close fails", async () => {
  const current = peer("one");
  const config: AgentConfig = {
    version: 1,
    server: { host: "127.0.0.1", port: 1 },
    localBearerHash: "a".repeat(64),
    peers: [current],
  };
  const app = new AgentApplication({
    config: { readEffect: () => Effect.succeed(config) },
    createRuntime: () => ({
      listWorkspacesEffect: () =>
        Effect.succeed({ node: { id: "node-one", name: "One" }, workspaces: [] }),
      askEffect: (workspace, question) => Effect.succeed({ workspace, answer: question }),
      closeEffect: () => Effect.fail(new Error("close failed")),
    }),
  });
  await Effect.runPromise(app.listPeersEffect());
  await expect(
    Effect.runPromise(app.retirePeerEffect(current.id, peerFingerprint(current))),
  ).rejects.toThrow("Peer retirement failed");
  await expect(
    Effect.runPromise(app.askEffect({ peer: "one", workspace: "docs", question: "blocked" })),
  ).rejects.toMatchObject({ code: "PEER_UNAVAILABLE" });
});
