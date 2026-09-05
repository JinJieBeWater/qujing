import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { QujingError } from "../src/errors";
import type { QujingEffectApi } from "../src/qujing";
import { createMcpNode, type McpHttpServer, type McpNodeOptions } from "../src/mcp";

const resources: Array<{
  node: McpHttpServer;
  server: ReturnType<typeof Bun.serve>;
  agent?: Client;
}> = [];

afterEach(async () => {
  await Promise.all(
    resources.splice(0).map(async ({ agent, node, server }) => {
      if (agent) await Promise.race([agent.close().catch(() => {}), Bun.sleep(100)]);
      await Promise.race([Promise.resolve(server.stop(true)), Bun.sleep(100)]);
      await Promise.race([Effect.runPromise(node.closeEffect).catch(() => {}), Bun.sleep(100)]);
    }),
  );
});

async function fixture(app?: QujingEffectApi, overrides: Partial<McpNodeOptions> = {}) {
  const application: QujingEffectApi = app ?? {
    listWorkspacesEffect: () =>
      Effect.succeed({
        node: { id: "node", name: "Node" },
        workspaces: [{ id: "docs", name: "Docs", summary: "Docs", available: true }],
      }),
    askEffect: ({ workspace, question }) =>
      Effect.succeed({ workspace, answer: `answer:${question}` }),
  };
  let node!: McpHttpServer;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => node.fetch(request),
  });
  node = createMcpNode({
    app: application,
    authenticateEffect: (bearer) =>
      Effect.succeed(
        bearer === "first-token"
          ? { id: "first", credentialVersion: "first-version" }
          : bearer === "rotated-token"
            ? { id: "first", credentialVersion: "rotated-version" }
            : bearer === "second-token"
              ? { id: "second", credentialVersion: "second-version" }
              : undefined,
      ),
    allowedHosts: ["127.0.0.1"],
    allowedOrigins: [],
    ...overrides,
  });
  resources.push({ node, server });
  return {
    node,
    server,
    url: new URL(`http://127.0.0.1:${server.port}/mcp`),
  };
}

describe("MCP node", () => {
  test("exposes exactly list_workspaces and ask with structured and text results", async () => {
    const { node, server, url } = await fixture();
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: "Bearer first-token" } },
    });
    const agent = new Client({ name: "test", version: "1" });
    resources[0] = { node, server, agent };
    await agent.connect(transport as Parameters<Client["connect"]>[0]);

    const tools = (await agent.listTools()).tools;
    expect(tools.map((tool) => tool.name)).toEqual(["list_workspaces", "ask"]);
    expect(tools.find((tool) => tool.name === "list_workspaces")?.annotations).toEqual({
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(tools.find((tool) => tool.name === "ask")?.annotations).toEqual({
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
    const listed = await agent.callTool({
      name: "list_workspaces",
      arguments: {},
    });
    expect(listed.structuredContent).toMatchObject({
      node: { id: "node" },
      workspaces: [{ id: "docs" }],
    });
    expect(listed.content).toEqual([
      { type: "text", text: JSON.stringify(listed.structuredContent) },
    ]);
    const asked = await agent.callTool({
      name: "ask",
      arguments: { workspace: "docs", question: "hello" },
    });
    expect(asked.structuredContent).toEqual({
      workspace: "docs",
      answer: "answer:hello",
    });
  });

  test("authenticates every request and binds MCP sessions to one Agent", async () => {
    const { node, server, url } = await fixture();
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: "Bearer first-token" } },
    });
    const agent = new Client({ name: "test", version: "1" });
    resources[0] = { node, server, agent };
    await agent.connect(transport as Parameters<Client["connect"]>[0]);

    const unauthorized = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(unauthorized.status).toBe(401);
    const hijack = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer second-token",
        "content-type": "application/json",
        "mcp-session-id": transport.sessionId!,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(hijack.status).toBe(403);
    const staleSession = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer rotated-token",
        "content-type": "application/json",
        "mcp-session-id": transport.sessionId!,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(staleSession.status).toBe(403);
    expect(transport.sessionId).toBeDefined();
  });

  test("delegates Question validation to the application", async () => {
    let received: string | undefined;
    const { node, server, url } = await fixture({
      listWorkspacesEffect: () =>
        Effect.succeed({ node: { id: "node", name: "Node" }, workspaces: [] }),
      askEffect: ({ question }) =>
        Effect.sync(() => {
          received = question;
          throw new QujingError("INVALID_QUESTION", "Question must not be empty");
        }),
    });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: "Bearer first-token" } },
    });
    const agent = new Client({ name: "test", version: "1" });
    resources[0] = { node, server, agent };
    await agent.connect(transport as Parameters<Client["connect"]>[0]);

    const result = await agent.callTool({
      name: "ask",
      arguments: { workspace: "docs", question: "   " },
    });

    expect(received).toBe("   ");
    expect(result).toMatchObject({ isError: true });
  });

  test("aborts active requests when an Agent session closes", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let markCancelled!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      markCancelled = resolve;
    });
    const { node, server, url } = await fixture({
      listWorkspacesEffect: () =>
        Effect.succeed({ node: { id: "node", name: "Node" }, workspaces: [] }),
      askEffect: (_request, signal) =>
        Effect.tryPromise({
          try: () => {
            markStarted();
            return new Promise((_resolve, reject) =>
              signal.addEventListener(
                "abort",
                () => {
                  markCancelled();
                  reject(signal.reason);
                },
                { once: true },
              ),
            );
          },
          catch: (error) => error,
        }),
    });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: "Bearer first-token" } },
    });
    const agent = new Client({ name: "test", version: "1" });
    resources[0] = { node, server, agent };
    await agent.connect(transport as Parameters<Client["connect"]>[0]);
    const pending = agent.callTool({
      name: "ask",
      arguments: { workspace: "docs", question: "wait" },
    });
    const pendingFailure = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    await started;

    const closing = Effect.runFork(node.closeCredentialEffect("first"));
    await Effect.runPromise(Fiber.interrupt(closing));

    await cancelled;
    expect(await pendingFailure).toMatchObject({ code: 499 });
  });

  test("rejects a bearer that becomes invalid after MCP initialization", async () => {
    let active = true;
    const { node, server, url } = await fixture(undefined, {
      authenticateEffect: (bearer) =>
        Effect.succeed(
          active && bearer === "first-token"
            ? { id: "first", credentialVersion: "first-version" }
            : undefined,
        ),
    });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: "Bearer first-token" } },
    });
    const agent = new Client({ name: "test", version: "1" });
    resources[0] = { node, server, agent };
    await agent.connect(transport as Parameters<Client["connect"]>[0]);
    active = false;

    await expect(agent.listTools()).rejects.toBeDefined();
  });

  test("bounds request bodies with and without Content-Length", async () => {
    const { node, url } = await fixture(undefined, {
      maxBodyBytes: 128,
      bodyTimeoutMs: 20,
    });
    const headers = {
      Authorization: "Bearer first-token",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    const declared = await fetch(url, {
      method: "POST",
      headers,
      body: "x".repeat(129),
    });
    expect(declared.status).toBe(413);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(129));
        controller.close();
      },
    });
    const streamed = await fetch(url, {
      method: "POST",
      headers,
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(streamed.status).toBe(413);
    const encoded = await node.fetch(
      new Request(url.href, {
        method: "POST",
        headers: { ...headers, Host: "127.0.0.1", "content-encoding": "gzip" },
        body: "{}",
      }),
    );
    expect(encoded.status).toBe(415);
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
    });
    const timedOut = await node.fetch(
      new Request(url.href, {
        method: "POST",
        headers: { ...headers, Host: "127.0.0.1" },
        body: stalled,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );
    expect(timedOut.status).toBe(408);
  });

  test("enforces hard global and per-Agent MCP session capacity", async () => {
    const { node, server, url } = await fixture(undefined, {
      maxSessions: 1,
      maxCredentialSessions: 1,
    });
    const firstTransport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: "Bearer first-token" } },
    });
    const first = new Client({ name: "first", version: "1" });
    resources[0] = { node, server, agent: first };
    await first.connect(firstTransport as Parameters<Client["connect"]>[0]);
    const secondTransport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: "Bearer first-token" } },
    });
    const second = new Client({ name: "second", version: "1" });

    await expect(
      second.connect(secondTransport as Parameters<Client["connect"]>[0]),
    ).rejects.toBeDefined();
    await second.close().catch(() => {});
    await Effect.runPromise(node.closeCredentialEffect("first"));
    const replacementTransport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: "Bearer first-token" } },
    });
    const replacement = new Client({ name: "replacement", version: "1" });
    await expect(
      replacement.connect(replacementTransport as Parameters<Client["connect"]>[0]),
    ).resolves.toBeUndefined();
    await replacement.close();
  });

  test("serializes concurrent session reservations", async () => {
    const { url } = await fixture(undefined, {
      maxSessions: 1,
      maxCredentialSessions: 1,
    });
    const initialize = () =>
      Effect.tryPromise({
        try: () =>
          fetch(url, {
            method: "POST",
            headers: {
              Authorization: "Bearer first-token",
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                agentInfo: { name: "test", version: "1" },
              },
            }),
          }),
        catch: (error) => error,
      });
    const responses = await Effect.runPromise(
      Effect.all([initialize(), initialize()], { concurrency: "unbounded" }),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 429]);
  });

  test("evicts idle sessions through scoped lifecycle fiber", async () => {
    const { node, server, url } = await fixture(undefined, {
      maxSessions: 1,
      sessionIdleMs: 100,
    });
    const firstTransport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: "Bearer first-token" } },
    });
    const first = new Client({ name: "first", version: "1" });
    resources[0] = { node, server, agent: first };
    await first.connect(firstTransport as Parameters<Client["connect"]>[0]);
    await Bun.sleep(250);
    const replacement = new Client({ name: "replacement", version: "1" });
    await expect(
      replacement.connect(
        new StreamableHTTPClientTransport(url, {
          requestInit: { headers: { Authorization: "Bearer first-token" } },
        }) as Parameters<Client["connect"]>[0],
      ),
    ).resolves.toBeUndefined();
    await replacement.close();
  });

  test("bounds concurrent requests independently from session slots", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app: QujingEffectApi = {
      listWorkspacesEffect: () =>
        Effect.succeed({ node: { id: "node", name: "Node" }, workspaces: [] }),
      askEffect: ({ workspace }) =>
        Effect.tryPromise({
          try: async () => {
            await blocked;
            return { workspace, answer: "done" };
          },
          catch: (error) => error,
        }),
    };
    const { node, server, url } = await fixture(app, {
      maxActiveRequests: 1,
      maxCredentialActiveRequests: 1,
    });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: "Bearer first-token" } },
    });
    const agent = new Client({ name: "test", version: "1" });
    resources[0] = { node, server, agent };
    await agent.connect(transport as Parameters<Client["connect"]>[0]);
    const pending = agent.callTool({
      name: "ask",
      arguments: { workspace: "docs", question: "wait" },
    });
    await Bun.sleep(10);
    const busy = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer first-token",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": transport.sessionId!,
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/list" }),
    });
    expect(busy.status).toBe(429);
    release();
    await pending;
  });

  test("rejects untrusted Host and Origin headers", async () => {
    const { url } = await fixture();
    const badHost = await fetch(url, { headers: { Host: "evil.example" } });
    expect(badHost.status).toBe(403);
    const badOrigin = await fetch(url, {
      headers: { Origin: "https://evil.example" },
    });
    expect(badOrigin.status).toBe(403);
    const connectorHost = await fetch(new URL("/healthz", url), {
      headers: { Host: "127.0.0.1:49999" },
    });
    expect(connectorHost.status).toBe(200);
  });

  test("accepts an explicitly allowed Origin", async () => {
    const { node, server, url } = await fixture(undefined, {
      allowedOrigins: ["https://trusted.example"],
    });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: {
          Authorization: "Bearer first-token",
          Origin: "https://trusted.example",
        },
      },
    });
    const agent = new Client({ name: "test", version: "1" });
    resources[0] = { node, server, agent };
    await expect(
      agent.connect(transport as Parameters<Client["connect"]>[0]),
    ).resolves.toBeUndefined();
  });

  test("propagates MCP cancellation to ask", async () => {
    let cancelled = false;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let markCancelled!: () => void;
    const cancellationObserved = new Promise<void>((resolve) => {
      markCancelled = resolve;
    });
    const app: QujingEffectApi = {
      listWorkspacesEffect: () =>
        Effect.succeed({ node: { id: "node", name: "Node" }, workspaces: [] }),
      askEffect: (_request, signal) =>
        Effect.tryPromise({
          try: () =>
            new Promise((_resolve, reject) => {
              markStarted();
              signal.addEventListener(
                "abort",
                () => {
                  cancelled = true;
                  markCancelled();
                  reject(signal.reason);
                },
                { once: true },
              );
            }),
          catch: (error) => error,
        }),
    };
    const { node, server, url } = await fixture(app);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: "Bearer first-token" } },
    });
    const agent = new Client({ name: "test", version: "1" });
    resources[0] = { node, server, agent };
    await agent.connect(transport as Parameters<Client["connect"]>[0]);
    const controller = new AbortController();
    const pending = agent.callTool(
      { name: "ask", arguments: { workspace: "docs", question: "wait" } },
      undefined,
      { signal: controller.signal },
    );
    await started;

    controller.abort();

    await expect(pending).rejects.toBeDefined();
    await cancellationObserved;
    expect(cancelled).toBe(true);
    await expect(agent.listTools()).resolves.toBeDefined();
  });

  test("fails shutdown after a bounded drain when an active handler ignores cancellation", async () => {
    let fatal: Error | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const app: QujingEffectApi = {
      listWorkspacesEffect: () =>
        Effect.succeed({ node: { id: "node", name: "Node" }, workspaces: [] }),
      askEffect: () =>
        Effect.uninterruptible(
          Effect.tryPromise({
            try: () => {
              markStarted();
              return new Promise(() => {});
            },
            catch: (error) => error,
          }),
        ),
    };
    const { node, server, url } = await fixture(app, {
      closeTimeoutMs: 10,
      shutdownTimeoutMs: 20,
      fatal: (error) => {
        fatal = error;
      },
    });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: "Bearer first-token" } },
    });
    const agent = new Client({ name: "test", version: "1" });
    resources[0] = { node, server, agent };
    await agent.connect(transport as Parameters<Client["connect"]>[0]);
    const pending = agent.callTool({
      name: "ask",
      arguments: { workspace: "docs", question: "never" },
    });
    void pending.catch(() => {});
    await started;

    await expect(Effect.runPromise(node.closeEffect)).rejects.toThrow("did not settle");
    expect(fatal?.message).toContain("did not settle");
  });
});
