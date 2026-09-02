import { expect, test } from "bun:test";
import { Deferred, Duration, Effect, Exit, Fiber } from "effect";

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
import { LineRuntime, type UpstreamClient, type UpstreamTransport } from "../src/line-runtime";

const line = {
  id: "line",
  expectedOwnerId: "owner",
  remoteClientId: "remote",
  serverAddress: "tailcat",
  remotePort: 43110,
  keyPath: "/key",
  remoteBearer: "secret",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function workspaceResult(name = "Owner") {
  return { structuredContent: { owner: { id: "owner", name }, workspaces: [] } };
}

function fixture(callTool: UpstreamClient["callTool"]) {
  let starts = 0;
  const events: string[] = [];
  const runtime = new LineRuntime({
    line,
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
        },
      } satisfies UpstreamTransport,
      client: {
        connect: async () => {},
        close: async () => {
          events.push("client-close");
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
    return workspaceResult(`Owner ${lists}`);
  });

  expect((await Effect.runPromise(runtime.listWorkspacesEffect())).owner.name).toBe("Owner 2");
  expect((await Effect.runPromise(runtime.listWorkspacesEffect())).owner.name).toBe("Owner 3");
  expect(starts()).toBe(1);
  await Effect.runPromise(runtime.closeEffect());
});

test("shares one pending bootstrap across concurrent first requests", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let starts = 0;
      const runtime = new LineRuntime({
        line,
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
          client: {
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
    code: "LINE_UNAVAILABLE",
  });
  expect(asks).toBe(1);
  expect(askOptions?.signal).not.toBe(controller.signal);
  expect(askOptions?.timeout).toBeGreaterThan(125_000);
  expect(starts()).toBe(1);
  await Effect.runPromise(runtime.listWorkspacesEffect());
  expect(starts()).toBe(2);
  await Effect.runPromise(runtime.closeEffect());
});

test("preserves safe Gateway errors without dropping the session", async () => {
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

test("rejects Owner mismatch and closes upstream in protocol order", async () => {
  const { runtime, events } = fixture(async () => ({
    structuredContent: { owner: { id: "other", name: "Other" }, workspaces: [] },
  }));

  await expect(Effect.runPromise(runtime.listWorkspacesEffect())).rejects.toMatchObject({
    code: "OWNER_ID_MISMATCH",
  });
  expect(events.indexOf("terminate")).toBeLessThan(events.indexOf("client-close"));
  expect(events).toContain("connector-close");
});

test("retries after a transient bootstrap failure", async () => {
  let starts = 0;
  const runtime = new LineRuntime({
    line,
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
      client: {
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
    owner: { id: "owner" },
  });
  expect(starts).toBe(2);
  await Effect.runPromise(runtime.closeEffect());
});

test("aborts and cleans up a cancelled first-request bootstrap", async () => {
  let bootstrapAborted = false;
  let connectorClosed = false;
  const runtime = new LineRuntime({
    line,
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
        const runtime = new LineRuntime({
          line,
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
  let clientClosed = false;
  const runtime = new LineRuntime({
    line,
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
      client: {
        connect: () =>
          new Promise<void>((resolve) => {
            releaseConnect = resolve;
          }),
        callTool: async () => workspaceResult(),
        close: async () => {
          clientClosed = true;
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
  expect(clientClosed).toBe(true);
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
      expect(events).toEqual(["terminate", "client-close", "connector-close"]);
    }),
  ));
