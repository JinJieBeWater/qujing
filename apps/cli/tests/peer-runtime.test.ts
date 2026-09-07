import { expect, test } from "bun:test";
import { Deferred, Duration, Effect, Exit, Fiber } from "effect";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startConnectorEffect, type TransportProcess } from "../src/transport/process";

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
import { PeerRuntime, type UpstreamAgent, type UpstreamTransport } from "../src/peer-runtime";

const peer = {
  id: "peer",
  expectedNodeId: "node",
  remoteAgentId: "remote",
  serverAddress: "tailcat",
  remotePort: 43110,
  keyPath: "/key",
  remoteBearer: "secret",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function workspaceResult(name = "Node") {
  return { structuredContent: { node: { id: "node", name }, workspaces: [] } };
}

function fixture(callTool: UpstreamAgent["callTool"], terminate?: () => Promise<void>) {
  let starts = 0;
  const events: string[] = [];
  const runtime = new PeerRuntime({
    peer,
    startConnectorEffect: () =>
      Effect.sync(() => {
        starts++;
        return {
          ready: { ready: true, localAddress: "127.0.0.1:4567" },
          exitedEffect: Effect.never,
          closeEffect: () => Effect.sync(() => events.push("connector-close")),
        };
      }),
    createUpstream: () => ({
      transport: {
        terminateSession: async () => {
          events.push("terminate");
          await terminate?.();
        },
      } satisfies UpstreamTransport,
      agent: {
        connect: async () => {},
        close: async () => {
          events.push("agent-close");
        },
        callTool,
      },
    }),
  });
  return { runtime, events, starts: () => starts };
}

test("uses one verified lazy session and refreshes Workspace metadata", async () => {
  let lists = 0;
  const { runtime, starts } = fixture(async ({ name }) => {
    if (name !== "list_workspaces") throw new Error("unexpected tool");
    lists++;
    return workspaceResult(`Node ${lists}`);
  });

  expect((await Effect.runPromise(runtime.listWorkspacesEffect())).node.name).toBe("Node 2");
  expect((await Effect.runPromise(runtime.listWorkspacesEffect())).node.name).toBe("Node 3");
  expect(starts()).toBe(1);
  await Effect.runPromise(runtime.closeEffect());
});

test("shares one pending bootstrap across concurrent first requests", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let starts = 0;
      const runtime = new PeerRuntime({
        peer,
        startConnectorEffect: () =>
          Effect.sync(() => {
            starts++;
          }).pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Deferred.await(release)),
            Effect.as({
              ready: { ready: true, localAddress: "127.0.0.1:4567" },
              exitedEffect: Effect.never,
              closeEffect: () => Effect.void,
            }),
          ),
        createUpstream: () => ({
          transport: {},
          agent: {
            connect: async () => {},
            callTool: async () => workspaceResult(),
            close: async () => {},
          },
        }),
      });
      const requests = yield* Effect.all(
        [runtime.listWorkspacesEffect(), runtime.listWorkspacesEffect()],
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);

      yield* Deferred.await(started);
      expect(starts).toBe(1);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(requests)).toHaveLength(2);
      yield* runtime.closeEffect();
    }),
  ));

test("forwards list cancellation without discarding verified session", async () => {
  let lists = 0;
  const { runtime, starts } = fixture(async ({ name }, _schema, options) => {
    if (name !== "list_workspaces") throw new Error("unexpected tool");
    lists++;
    if (lists === 2) {
      return new Promise((_, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    }
    return workspaceResult();
  });
  const controller = new AbortController();
  const pending = Effect.runPromise(runtime.listWorkspacesEffect(controller.signal));
  await sleep(10);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await Effect.runPromise(runtime.listWorkspacesEffect());
  expect(starts()).toBe(1);
  await Effect.runPromise(runtime.closeEffect());
});

test("never retries a dispatched ask and reconnects only on a later call", async () => {
  let asks = 0;
  let askOptions: { signal?: AbortSignal; timeout?: number } | undefined;
  const { runtime, starts } = fixture(async ({ name }, _schema, options) => {
    if (name === "list_workspaces") return workspaceResult();
    asks++;
    askOptions = options;
    throw new Error("network");
  });
  const controller = new AbortController();

  await expect(
    Effect.runPromise(runtime.askEffect("ws", "q", controller.signal)),
  ).rejects.toMatchObject({
    code: "PEER_UNAVAILABLE",
  });
  expect(asks).toBe(1);
  expect(askOptions?.signal).not.toBe(controller.signal);
  expect(askOptions?.timeout).toBeGreaterThan(125_000);
  expect(starts()).toBe(1);
  await Effect.runPromise(runtime.listWorkspacesEffect());
  expect(starts()).toBe(2);
  await Effect.runPromise(runtime.closeEffect());
});

test("preserves safe Node errors without dropping the session", async () => {
  const { runtime, starts } = fixture(async ({ name }) =>
    name === "list_workspaces"
      ? workspaceResult()
      : {
          isError: true,
          content: [{ type: "text", text: "WORKSPACE_NOT_FOUND: Workspace not found" }],
        },
  );

  await expect(Effect.runPromise(runtime.askEffect("missing", "q"))).rejects.toMatchObject({
    code: "WORKSPACE_NOT_FOUND",
  });
  await Effect.runPromise(runtime.listWorkspacesEffect());
  expect(starts()).toBe(1);
  await Effect.runPromise(runtime.closeEffect());
});

test("rejects Node mismatch and closes upstream in protocol order", async () => {
  const { runtime, events } = fixture(async () => ({
    structuredContent: { node: { id: "other", name: "Other" }, workspaces: [] },
  }));

  await expect(Effect.runPromise(runtime.listWorkspacesEffect())).rejects.toMatchObject({
    code: "NODE_ID_MISMATCH",
  });
  expect(events.indexOf("terminate")).toBeLessThan(events.indexOf("agent-close"));
  expect(events).toContain("connector-close");
});

test("retries after a transient bootstrap failure", async () => {
  let starts = 0;
  const runtime = new PeerRuntime({
    peer,
    startConnectorEffect: () =>
      Effect.tryPromise({
        try: async () => {
          starts++;
          if (starts === 1) throw new Error("temporary network failure");
          return {
            ready: { ready: true, localAddress: "127.0.0.1:4567" },
            exitedEffect: Effect.never,
            closeEffect: () => Effect.void,
          };
        },
        catch: (error) => error,
      }),
    createUpstream: () => ({
      transport: {},
      agent: {
        connect: async () => {},
        callTool: async () => workspaceResult(),
        close: async () => {},
      },
    }),
  });

  await expect(Effect.runPromise(runtime.listWorkspacesEffect())).rejects.toThrow(
    "temporary network failure",
  );
  await expect(Effect.runPromise(runtime.listWorkspacesEffect())).resolves.toMatchObject({
    node: { id: "node" },
  });
  expect(starts).toBe(2);
  await Effect.runPromise(runtime.closeEffect());
});

test("aborts and cleans up a cancelled first-request bootstrap", async () => {
  let bootstrapAborted = false;
  let connectorClosed = false;
  const runtime = new PeerRuntime({
    peer,
    startConnectorEffect: (_options, signal) =>
      Effect.tryPromise({
        try: async () => {
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                bootstrapAborted = true;
                reject(new DOMException("Aborted", "AbortError"));
              },
              { once: true },
            );
          });
          return {
            ready: { ready: true, localAddress: "127.0.0.1:4567" },
            exitedEffect: Effect.succeed(0),
            closeEffect: () =>
              Effect.sync(() => {
                connectorClosed = true;
              }),
          };
        },
        catch: (error) => error,
      }),
    createUpstream: () => {
      throw new Error("upstream must not start");
    },
  });
  const controller = new AbortController();
  const pending = Effect.runPromise(runtime.listWorkspacesEffect(controller.signal));
  await sleep(10);
  controller.abort();

  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await sleep(10);
  expect(bootstrapAborted).toBe(true);
  expect(connectorClosed).toBe(false);
  await Effect.runPromise(runtime.closeEffect());
});

test("interrupts a never-settling bootstrap during close", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const runtime = new PeerRuntime({
          peer,
          startConnectorEffect: () =>
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          createUpstream: () => {
            throw new Error("upstream must not start");
          },
        });
        const request = yield* runtime.listWorkspacesEffect().pipe(Effect.forkChild);
        yield* Deferred.await(started);

        yield* runtime.closeEffect().pipe(Effect.timeout(Duration.seconds(1)));

        expect(Exit.isFailure(yield* Fiber.await(request))).toBe(true);
      }),
    ),
  ));

test("disposes a late bootstrap result after its only waiter cancels", async () => {
  let releaseConnect!: () => void;
  let connectorClosed = false;
  let agentClosed = false;
  const runtime = new PeerRuntime({
    peer,
    startConnectorEffect: () =>
      Effect.succeed({
        ready: { ready: true, localAddress: "127.0.0.1:4567" },
        exitedEffect: Effect.never,
        closeEffect: () =>
          Effect.sync(() => {
            connectorClosed = true;
          }),
      }),
    createUpstream: () => ({
      transport: {},
      agent: {
        connect: () =>
          new Promise<void>((resolve) => {
            releaseConnect = resolve;
          }),
        callTool: async () => workspaceResult(),
        close: async () => {
          agentClosed = true;
        },
      },
    }),
  });
  const controller = new AbortController();
  const pending = Effect.runPromise(runtime.listWorkspacesEffect(controller.signal));
  while (!releaseConnect) await sleep(1);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  releaseConnect();
  await sleep(10);
  expect(agentClosed).toBe(true);
  expect(connectorClosed).toBe(true);
  await Effect.runPromise(runtime.closeEffect());
});

test("runs session close as scoped finalizer", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { runtime, events } = fixture(async () => workspaceResult());
      yield* Effect.scoped(
        Effect.acquireRelease(Effect.succeed(runtime), (resource) =>
          resource.closeEffect().pipe(Effect.catchEager(() => Effect.void)),
        ).pipe(
          Effect.flatMap((resource) => resource.listWorkspacesEffect()),
          Effect.asVoid,
        ),
      );
      expect(events).toEqual(["terminate", "agent-close", "connector-close"]);
    }),
  ));

test("closes client and Connector even when MCP termination fails", async () => {
  const { runtime, events } = fixture(
    async () => workspaceResult(),
    async () => {
      throw new Error("remote is offline");
    },
  );
  await Effect.runPromise(runtime.listWorkspacesEffect());
  await Effect.runPromise(runtime.closeEffect());
  expect(events).toEqual(["terminate", "agent-close", "connector-close"]);
});

test.each(["termination", "client close"])(
  "closes a real Connector when upstream %s never settles",
  async (stage) => {
    const root = await mkdtemp(join(tmpdir(), "qujing-peer-close-"));
    const binary = join(root, "connector");
    const pidPath = join(root, "pid");
    let releaseTerminate!: () => void;
    const terminate = new Promise<void>((resolve) => {
      releaseTerminate = resolve;
    });
    let connector: TransportProcess | undefined;
    let clientClosed = false;
    let closing: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const runtime = new PeerRuntime({
      peer,
      startConnectorEffect: (options, signal) =>
        startConnectorEffect(options, binary, signal).pipe(
          Effect.tap((started) =>
            Effect.sync(() => {
              connector = started;
            }),
          ),
        ),
      createUpstream: () => ({
        transport: {
          terminateSession: async () => {
            if (stage === "termination") await terminate;
          },
        },
        agent: {
          connect: async () => {},
          callTool: async () => workspaceResult(),
          close: async () => {
            clientClosed = true;
            if (stage === "client close") await terminate;
          },
        },
      }),
    });
    try {
      await writeFile(
        binary,
        `#!${process.execPath}
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ready") });
await Bun.write(${JSON.stringify(pidPath)}, String(process.pid));
console.log(JSON.stringify({ ready: true, localAddress: "127.0.0.1:" + server.port }));
`,
      );
      await chmod(binary, 0o700);
      await Effect.runPromise(runtime.listWorkspacesEffect());
      const pid = Number(await Bun.file(pidPath).text());
      const url = `http://${connector!.ready.localAddress}`;
      expect((await fetch(url)).status).toBe(200);
      closing = Effect.runPromise(
        Effect.scoped(
          Effect.acquireRelease(Effect.succeed(runtime), (resource) =>
            resource.closeEffect().pipe(Effect.orDie),
          ),
        ).pipe(Effect.asVoid),
      );
      await Promise.race([
        closing,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Peer cleanup exceeded deadline")), 2_000);
        }),
      ]);
      expect(clientClosed).toBe(true);
      expect(() => process.kill(pid, 0)).toThrow();
      await expect(fetch(url)).rejects.toBeDefined();
    } finally {
      clearTimeout(timer);
      releaseTerminate();
      await closing;
      if (connector) await Effect.runPromise(connector.closeEffect());
      await Effect.runPromise(runtime.closeEffect());
      await rm(root, { recursive: true, force: true });
    }
  },
);
