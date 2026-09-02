import { expect, test } from "bun:test";
import { Effect } from "effect";
import {
  ClientApplication,
  lineFingerprint,
  type LineRuntimeClient,
} from "../src/client-application";
import type { ClientConfig, LineConfig } from "../src/client-config";

const now = new Date().toISOString();
const line = (id: string): LineConfig => ({
  id,
  expectedOwnerId: `owner-${id}`,
  remoteClientId: id,
  serverAddress: id,
  remotePort: 1,
  keyPath: `/${id}`,
  remoteBearer: id,
  createdAt: now,
  updatedAt: now,
});

function runtime(
  listWorkspacesEffect: LineRuntimeClient["listWorkspacesEffect"],
  askEffect: LineRuntimeClient["askEffect"] = (workspace, question) =>
    Effect.succeed({ workspace, answer: question }),
) {
  return { listWorkspacesEffect, askEffect, closeEffect: () => Effect.void };
}

test("aggregates Lines in config order and isolates unavailable Line", async () => {
  const config: ClientConfig = {
    version: 1,
    server: { host: "127.0.0.1", port: 1 },
    localBearerHash: "a".repeat(64),
    lines: [line("one"), line("two")],
  };
  const app = new ClientApplication({
    config: { readEffect: () => Effect.succeed(config) },
    createRuntime: (entry) =>
      runtime(() =>
        entry.id === "one"
          ? Effect.succeed({ owner: { id: "owner-one", name: "One" }, workspaces: [] })
          : Effect.fail(new Error("private")),
      ),
  });
  expect(await Effect.runPromise(app.listLinesEffect())).toEqual([
    { id: "one", available: true, owner: { id: "owner-one", name: "One" }, workspaces: [] },
    { id: "two", available: false, workspaces: [] },
  ]);
});

test("routes ask to exact Line and closes only changed runtime", async () => {
  const first = line("one");
  const second = line("two");
  let config: ClientConfig = {
    version: 1,
    server: { host: "127.0.0.1", port: 1 },
    localBearerHash: "a".repeat(64),
    lines: [first, second],
  };
  const calls: string[] = [];
  const closed: string[] = [];
  const app = new ClientApplication({
    config: { readEffect: () => Effect.succeed(config) },
    createRuntime: (entry) =>
      ({
        listWorkspacesEffect: () =>
          Effect.succeed({ owner: { id: entry.expectedOwnerId, name: entry.id }, workspaces: [] }),
        askEffect: (workspace, question) =>
          Effect.sync(() => {
            calls.push(entry.id);
            return { workspace, answer: question };
          }),
        closeEffect: () => Effect.sync(() => closed.push(entry.id)),
      }) as LineRuntimeClient,
  });
  expect(
    await Effect.runPromise(app.askEffect({ line: "two", workspace: "w", question: "q" })),
  ).toEqual({
    line: "two",
    workspace: "w",
    answer: "q",
  });
  expect(calls).toEqual(["two"]);
  config = { ...config, lines: [{ ...first, remoteBearer: "new" }, second] };
  await Effect.runPromise(app.reconcileEffect());
  expect(closed).toEqual([]);
  await Effect.runPromise(app.listLinesEffect());
  config = { ...config, lines: [{ ...config.lines[0]!, remoteBearer: "newer" }, second] };
  await Effect.runPromise(app.reconcileEffect());
  expect(closed).toEqual(["one"]);
});

test("cancellation reaches every Line", async () => {
  const config: ClientConfig = {
    version: 1,
    server: { host: "127.0.0.1", port: 1 },
    localBearerHash: "a".repeat(64),
    lines: [line("one"), line("two")],
  };
  let aborted = 0;
  const app = new ClientApplication({
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
  const pending = Effect.runPromise(app.listLinesEffect(controller.signal));
  await Bun.sleep(1);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(aborted).toBe(2);
});

test("serializes config snapshots so stale runtimes cannot survive reconciliation", async () => {
  const oldLine = line("one");
  const newLine = { ...oldLine, remoteBearer: "new" };
  let releaseFirst!: () => void;
  let reads = 0;
  const closed: string[] = [];
  const app = new ClientApplication({
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
              lines: [reads === 1 ? oldLine : newLine],
            };
          },
          catch: (error) => error,
        }),
    },
    createRuntime: (entry) =>
      ({
        listWorkspacesEffect: () =>
          Effect.succeed({
            owner: { id: entry.expectedOwnerId, name: entry.remoteBearer },
            workspaces: [],
          }),
        askEffect: (workspace, question) => Effect.succeed({ workspace, answer: question }),
        closeEffect: () => Effect.sync(() => closed.push(entry.remoteBearer)),
      }) satisfies LineRuntimeClient,
  });

  const oldRequest = Effect.runPromise(app.listLinesEffect());
  while (!releaseFirst) await Bun.sleep(1);
  const reconcile = Effect.runPromise(app.reconcileEffect());
  releaseFirst();
  await oldRequest;
  await reconcile;
  expect(closed).toEqual(["one"]);
  expect((await Effect.runPromise(app.listLinesEffect()))[0]?.owner?.name).toBe("new");
  await Effect.runPromise(app.closeEffect());
});

test("close is terminal and catches a concurrent runtime acquisition", async () => {
  const config: ClientConfig = {
    version: 1,
    server: { host: "127.0.0.1", port: 1 },
    localBearerHash: "a".repeat(64),
    lines: [line("one")],
  };
  let closed = 0;
  const app = new ClientApplication({
    config: { readEffect: () => Effect.succeed(config) },
    createRuntime: () =>
      ({
        listWorkspacesEffect: () =>
          Effect.succeed({ owner: { id: "owner-one", name: "One" }, workspaces: [] }),
        askEffect: (workspace, question) => Effect.succeed({ workspace, answer: question }),
        closeEffect: () => Effect.sync(() => closed++),
      }) satisfies LineRuntimeClient,
  });

  await Effect.runPromise(app.listLinesEffect());
  await Effect.runPromise(app.closeEffect());
  expect(closed).toBe(1);
  await expect(Effect.runPromise(app.listLinesEffect())).rejects.toMatchObject({
    code: "LINE_UNAVAILABLE",
  });
});

test("retires one Line only after active work settles and blocks old credentials", async () => {
  const oldLine = line("one");
  let config: ClientConfig = {
    version: 1,
    server: { host: "127.0.0.1", port: 1 },
    localBearerHash: "a".repeat(64),
    lines: [oldLine],
  };
  let started!: () => void;
  const active = new Promise<void>((resolve) => {
    started = resolve;
  });
  const retirementEvents: string[] = [];
  const app = new ClientApplication({
    config: { readEffect: () => Effect.succeed(config) },
    createRuntime: () => ({
      listWorkspacesEffect: () =>
        Effect.succeed({ owner: { id: "owner-one", name: "One" }, workspaces: [] }),
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
    app.askEffect({ line: "one", workspace: "docs", question: "wait" }),
  );
  await active;
  await Effect.runPromise(app.retireLineEffect(oldLine.id, lineFingerprint(oldLine)));
  expect(retirementEvents).toEqual(["settled", "closed"]);
  await expect(pending).rejects.toMatchObject({ code: "LINE_UNAVAILABLE" });
  await expect(
    Effect.runPromise(app.askEffect({ line: "one", workspace: "docs", question: "blocked" })),
  ).rejects.toMatchObject({ code: "LINE_UNAVAILABLE" });

  config = { ...config, lines: [{ ...oldLine, remoteBearer: "new" }] };
  await Effect.runPromise(app.reconcileEffect());
  expect((await Effect.runPromise(app.listLinesEffect()))[0]?.available).toBe(true);
  await Effect.runPromise(app.closeEffect());
});

test("does not complete Line retirement when runtime close fails", async () => {
  const current = line("one");
  const config: ClientConfig = {
    version: 1,
    server: { host: "127.0.0.1", port: 1 },
    localBearerHash: "a".repeat(64),
    lines: [current],
  };
  const app = new ClientApplication({
    config: { readEffect: () => Effect.succeed(config) },
    createRuntime: () => ({
      listWorkspacesEffect: () =>
        Effect.succeed({ owner: { id: "owner-one", name: "One" }, workspaces: [] }),
      askEffect: (workspace, question) => Effect.succeed({ workspace, answer: question }),
      closeEffect: () => Effect.fail(new Error("close failed")),
    }),
  });
  await Effect.runPromise(app.listLinesEffect());
  await expect(
    Effect.runPromise(app.retireLineEffect(current.id, lineFingerprint(current))),
  ).rejects.toThrow("Line retirement failed");
  await expect(
    Effect.runPromise(app.askEffect({ line: "one", workspace: "docs", question: "blocked" })),
  ).rejects.toMatchObject({ code: "LINE_UNAVAILABLE" });
});
