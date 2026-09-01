import { expect, test } from "bun:test";
import {
  ClientApplication,
  lineFingerprint,
  type LineRuntimeClient,
} from "../src/client-application";
import type { ClientConfig, LineConfig } from "../src/client-config";
import { LineRuntime } from "../src/line-runtime";

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
  fn: LineRuntime["listWorkspaces"],
  ask: LineRuntime["ask"] = async (workspace, question) => ({ workspace, answer: question }),
) {
  return { listWorkspaces: fn, ask, close: async () => {} } as LineRuntimeClient;
}

test("aggregates Lines in config order and isolates unavailable Line", async () => {
  const config: ClientConfig = {
    version: 1,
    server: { host: "127.0.0.1", port: 1 },
    localBearerHash: "a".repeat(64),
    lines: [line("one"), line("two")],
  };
  const app = new ClientApplication({
    config: { read: async () => config },
    createRuntime: (entry) =>
      runtime(async () =>
        entry.id === "one"
          ? { owner: { id: "owner-one", name: "One" }, workspaces: [] }
          : Promise.reject(new Error("private")),
      ),
  });
  expect(await app.listLines()).toEqual([
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
    config: { read: async () => config },
    createRuntime: (entry) =>
      ({
        listWorkspaces: async () => ({
          owner: { id: entry.expectedOwnerId, name: entry.id },
          workspaces: [],
        }),
        ask: async (workspace, question) => {
          calls.push(entry.id);
          return { workspace, answer: question };
        },
        close: async () => {
          closed.push(entry.id);
        },
      }) as LineRuntimeClient,
  });
  expect(await app.ask({ line: "two", workspace: "w", question: "q" })).toEqual({
    line: "two",
    workspace: "w",
    answer: "q",
  });
  expect(calls).toEqual(["two"]);
  config = { ...config, lines: [{ ...first, remoteBearer: "new" }, second] };
  await app.reconcile();
  expect(closed).toEqual([]);
  await app.listLines();
  config = { ...config, lines: [{ ...config.lines[0]!, remoteBearer: "newer" }, second] };
  await app.reconcile();
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
    config: { read: async () => config },
    createRuntime: () =>
      runtime(
        async (signal) =>
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
      ),
  });
  const controller = new AbortController();
  const pending = app.listLines(controller.signal);
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
      read: async () => {
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
    },
    createRuntime: (entry) =>
      ({
        listWorkspaces: async () => ({
          owner: { id: entry.expectedOwnerId, name: entry.remoteBearer },
          workspaces: [],
        }),
        ask: async (workspace, question) => ({ workspace, answer: question }),
        close: async () => {
          closed.push(entry.remoteBearer);
        },
      }) satisfies LineRuntimeClient,
  });

  const oldRequest = app.listLines();
  while (!releaseFirst) await Bun.sleep(1);
  const reconcile = app.reconcile();
  releaseFirst();
  await oldRequest;
  await reconcile;
  expect(closed).toEqual(["one"]);
  expect((await app.listLines())[0]?.owner?.name).toBe("new");
  await app.close();
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
    config: { read: async () => config },
    createRuntime: () =>
      ({
        listWorkspaces: async () => ({ owner: { id: "owner-one", name: "One" }, workspaces: [] }),
        ask: async (workspace, question) => ({ workspace, answer: question }),
        close: async () => {
          closed++;
        },
      }) satisfies LineRuntimeClient,
  });

  await app.listLines();
  await app.close();
  expect(closed).toBe(1);
  await expect(app.listLines()).rejects.toMatchObject({ code: "LINE_UNAVAILABLE" });
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
  let settled = false;
  let closed = false;
  const app = new ClientApplication({
    config: { read: async () => config },
    createRuntime: () => ({
      listWorkspaces: async () => ({ owner: { id: "owner-one", name: "One" }, workspaces: [] }),
      ask: async (_workspace, _question, signal) => {
        started();
        return new Promise((_resolve, reject) =>
          signal?.addEventListener(
            "abort",
            async () => {
              await Bun.sleep(10);
              settled = true;
              reject(signal.reason);
            },
            { once: true },
          ),
        );
      },
      close: async () => {
        closed = true;
      },
    }),
  });
  const pending = app.ask({ line: "one", workspace: "docs", question: "wait" });
  await active;
  await app.retireLine(oldLine.id, lineFingerprint(oldLine));
  expect({ settled, closed }).toEqual({ settled: true, closed: true });
  await expect(pending).rejects.toMatchObject({ code: "LINE_UNAVAILABLE" });
  await expect(
    app.ask({ line: "one", workspace: "docs", question: "blocked" }),
  ).rejects.toMatchObject({ code: "LINE_UNAVAILABLE" });

  config = { ...config, lines: [{ ...oldLine, remoteBearer: "new" }] };
  await app.reconcile();
  expect((await app.listLines())[0]?.available).toBe(true);
  await app.close();
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
    config: { read: async () => config },
    createRuntime: () => ({
      listWorkspaces: async () => ({ owner: { id: "owner-one", name: "One" }, workspaces: [] }),
      ask: async (workspace, question) => ({ workspace, answer: question }),
      close: async () => {
        throw new Error("close failed");
      },
    }),
  });
  await app.listLines();
  await expect(app.retireLine(current.id, lineFingerprint(current))).rejects.toThrow(
    "Line retirement failed",
  );
  await expect(
    app.ask({ line: "one", workspace: "docs", question: "blocked" }),
  ).rejects.toMatchObject({ code: "LINE_UNAVAILABLE" });
});
