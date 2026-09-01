import { expect, test } from "bun:test";
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
    startConnector: async () => {
      starts++;
      return {
        ready: { ready: true, localAddress: "127.0.0.1:4567" },
        exited: new Promise(() => {}),
        close: async () => {
          events.push("connector-close");
        },
      };
    },
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

  expect((await runtime.listWorkspaces()).owner.name).toBe("Owner 2");
  expect((await runtime.listWorkspaces()).owner.name).toBe("Owner 3");
  expect(starts()).toBe(1);
  await runtime.close();
});

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
  const pending = runtime.listWorkspaces(controller.signal);
  await Bun.sleep(10);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await runtime.listWorkspaces();
  expect(starts()).toBe(1);
  await runtime.close();
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

  await expect(runtime.ask("ws", "q", controller.signal)).rejects.toMatchObject({
    code: "LINE_UNAVAILABLE",
  });
  expect(asks).toBe(1);
  expect(askOptions?.signal).toBe(controller.signal);
  expect(askOptions?.timeout).toBeGreaterThan(125_000);
  expect(starts()).toBe(1);
  await runtime.listWorkspaces();
  expect(starts()).toBe(2);
  await runtime.close();
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

  await expect(runtime.ask("missing", "q")).rejects.toMatchObject({
    code: "WORKSPACE_NOT_FOUND",
  });
  await runtime.listWorkspaces();
  expect(starts()).toBe(1);
  await runtime.close();
});

test("rejects Owner mismatch and closes upstream in protocol order", async () => {
  const { runtime, events } = fixture(async () => ({
    structuredContent: { owner: { id: "other", name: "Other" }, workspaces: [] },
  }));

  await expect(runtime.listWorkspaces()).rejects.toMatchObject({ code: "OWNER_ID_MISMATCH" });
  expect(events.indexOf("terminate")).toBeLessThan(events.indexOf("client-close"));
  expect(events).toContain("connector-close");
});

test("aborts and cleans up a cancelled first-request bootstrap", async () => {
  let bootstrapAborted = false;
  let connectorClosed = false;
  const runtime = new LineRuntime({
    line,
    startConnector: async (_options, signal) => {
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
        exited: Promise.resolve(0),
        close: async () => {
          connectorClosed = true;
        },
      };
    },
    createUpstream: () => {
      throw new Error("upstream must not start");
    },
  });
  const controller = new AbortController();
  const pending = runtime.listWorkspaces(controller.signal);
  await Bun.sleep(10);
  controller.abort();

  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await Bun.sleep(10);
  expect(bootstrapAborted).toBe(true);
  expect(connectorClosed).toBe(false);
  await runtime.close();
});

test("disposes a late bootstrap result after its only waiter cancels", async () => {
  let releaseConnect!: () => void;
  let connectorClosed = false;
  let clientClosed = false;
  const runtime = new LineRuntime({
    line,
    startConnector: async () => ({
      ready: { ready: true, localAddress: "127.0.0.1:4567" },
      exited: new Promise(() => {}),
      close: async () => {
        connectorClosed = true;
      },
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
  const pending = runtime.listWorkspaces(controller.signal);
  while (!releaseConnect) await Bun.sleep(1);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  releaseConnect();
  await Bun.sleep(10);
  expect(clientClosed).toBe(true);
  expect(connectorClosed).toBe(true);
  await runtime.close();
});
