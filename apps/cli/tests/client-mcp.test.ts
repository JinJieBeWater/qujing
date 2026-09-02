import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ClientApplication, type LineRuntimeClient } from "../src/client-application";
import type { ClientConfig, LineConfig } from "../src/client-config";
import { createClientMcp, type ClientMcpOptions } from "../src/client-mcp";
import { ColleagueLineError } from "../src/errors";
import type { McpGateway } from "../src/mcp";
import { Effect } from "effect";

const resources: Array<{ mcp: McpGateway; server: ReturnType<typeof Bun.serve>; client?: Client }> =
  [];
afterEach(async () => {
  await Promise.all(
    resources.splice(0).map(async ({ mcp, server, client }) => {
      server.stop(true);
      await Promise.all([
        Promise.race([client?.close().catch(() => {}), Bun.sleep(100)]),
        Promise.race([Effect.runPromise(mcp.closeEffect).catch(() => {}), Bun.sleep(100)]),
      ]);
    }),
  );
});

const now = new Date().toISOString();
const line: LineConfig = {
  id: "line",
  expectedOwnerId: "owner",
  remoteClientId: "remote",
  serverAddress: "private",
  remotePort: 1,
  keyPath: "/key",
  remoteBearer: "secret",
  createdAt: now,
  updatedAt: now,
};

function fixture(
  options: {
    config?: ClientConfig;
    createRuntime?: (line: LineConfig) => LineRuntimeClient;
  } = {},
) {
  const config: ClientConfig = options.config ?? {
    version: 1,
    server: { host: "127.0.0.1", port: 1 },
    localBearerHash: "a".repeat(64),
    lines: [line],
  };
  const app = new ClientApplication({
    config: { readEffect: () => Effect.succeed(config) },
    createRuntime:
      options.createRuntime ??
      (() => ({
        listWorkspacesEffect: () =>
          Effect.succeed({ owner: { id: "owner", name: "Owner" }, workspaces: [] }),
        askEffect: (workspace, question) =>
          Effect.succeed({ workspace, answer: `answer:${question}` }),
        closeEffect: () => Effect.void,
      })),
  });
  let mcp!: McpGateway;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => mcp.fetch(request),
  });
  mcp = createClientMcp({
    app,
    config: {
      authenticateLocalEffect: (bearer) =>
        Effect.succeed(
          bearer === "local" ? { id: "local-agent", credentialVersion: "v1" } : undefined,
        ),
    },
    allowedHosts: ["127.0.0.1"],
    allowedOrigins: [],
  } satisfies ClientMcpOptions);
  resources.push({ mcp, server });
  return { mcp, server, url: new URL(`http://127.0.0.1:${server.port}/mcp`) };
}

test("Client MCP exposes only Client tools with local auth", async () => {
  const { mcp, server, url } = fixture();
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: "Bearer local" } },
  });
  const client = new Client({ name: "test", version: "1" });
  resources[0] = { mcp, server, client };
  await client.connect(transport as Parameters<Client["connect"]>[0]);
  const tools = (await client.listTools()).tools;
  expect(tools.map(({ name }) => name)).toEqual(["list_lines", "ask"]);
  expect(tools.find(({ name }) => name === "list_lines")?.annotations).toEqual({
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  });
  expect(tools.find(({ name }) => name === "ask")?.annotations).toEqual({
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: true,
    openWorldHint: true,
  });
  const listed = await client.callTool({ name: "list_lines", arguments: {} });
  expect(listed.structuredContent).toEqual({
    lines: [{ id: "line", available: true, owner: { id: "owner", name: "Owner" }, workspaces: [] }],
  });
  expect(listed.content).toEqual([
    { type: "text", text: JSON.stringify(listed.structuredContent) },
  ]);
  expect(
    await client.callTool({
      name: "ask",
      arguments: { line: "line", workspace: "ws", question: "q" },
    }),
  ).toMatchObject({ structuredContent: { line: "line", workspace: "ws", answer: "answer:q" } });
  const stale = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer old", "content-type": "application/json" },
    body: "{}",
  });
  expect(stale.status).toBe(401);
});

test("Agent MCP cancellation reaches the selected Line runtime", async () => {
  let cancelled = false;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let markCancelled!: () => void;
  const cancellationObserved = new Promise<void>((resolve) => {
    markCancelled = resolve;
  });
  const config: ClientConfig = {
    version: 1,
    server: { host: "127.0.0.1", port: 1 },
    localBearerHash: "a".repeat(64),
    lines: [line],
  };
  const app = new ClientApplication({
    config: { readEffect: () => Effect.succeed(config) },
    createRuntime: () =>
      ({
        listWorkspacesEffect: () =>
          Effect.succeed({ owner: { id: "owner", name: "Owner" }, workspaces: [] }),
        askEffect: (_workspace, _question, signal) =>
          Effect.tryPromise({
            try: () =>
              new Promise((_resolve, reject) => {
                markStarted();
                signal?.addEventListener(
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
        closeEffect: () => Effect.void,
      }) satisfies LineRuntimeClient,
  });
  let mcp!: McpGateway;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => mcp.fetch(request),
  });
  mcp = createClientMcp({
    app,
    config: {
      authenticateLocalEffect: (bearer) =>
        Effect.succeed(
          bearer === "local" ? { id: "local-agent", credentialVersion: "v1" } : undefined,
        ),
    },
    allowedHosts: ["127.0.0.1"],
    allowedOrigins: [],
  });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${server.port}/mcp`),
    { requestInit: { headers: { Authorization: "Bearer local" } } },
  );
  const client = new Client({ name: "test", version: "1" });
  resources.push({ mcp, server, client });
  await client.connect(transport as Parameters<Client["connect"]>[0]);
  const controller = new AbortController();
  const pending = client.callTool(
    { name: "ask", arguments: { line: "line", workspace: "ws", question: "wait" } },
    undefined,
    { signal: controller.signal },
  );
  await started;
  controller.abort();

  await expect(pending).rejects.toBeDefined();
  await cancellationObserved;
  expect(cancelled).toBe(true);
});

test("forwards raw questions to the Owner Line for domain validation", async () => {
  let received: string | undefined;
  const { mcp, server, url } = fixture({
    createRuntime: () => ({
      listWorkspacesEffect: () =>
        Effect.succeed({ owner: { id: "owner", name: "Owner" }, workspaces: [] }),
      askEffect: (_workspace, question) =>
        Effect.sync(() => {
          received = question;
          throw new ColleagueLineError("INVALID_QUESTION", "Remote request failed");
        }),
      closeEffect: () => Effect.void,
    }),
  });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: "Bearer local" } },
  });
  const client = new Client({ name: "test", version: "1" });
  resources[0] = { mcp, server, client };
  await client.connect(transport as Parameters<Client["connect"]>[0]);

  const result = await client.callTool({
    name: "ask",
    arguments: { line: "line", workspace: "ws", question: "   " },
  });

  expect(received).toBe("   ");
  expect(result).toMatchObject({ isError: true });
});

test("Agent MCP lists two Lines independently and routes each ask exactly", async () => {
  const second = {
    ...line,
    id: "second",
    expectedOwnerId: "owner-second",
    remoteClientId: "remote-second",
    remoteBearer: "secret-second",
  };
  const config: ClientConfig = {
    version: 1,
    server: { host: "127.0.0.1", port: 1 },
    localBearerHash: "a".repeat(64),
    lines: [line, second],
  };
  const routed: string[] = [];
  const { mcp, server, url } = fixture({
    config,
    createRuntime: (entry) => ({
      listWorkspacesEffect: () =>
        entry.id === "second"
          ? Effect.fail(new Error("offline"))
          : Effect.succeed({
              owner: { id: entry.expectedOwnerId, name: "Owner" },
              workspaces: [{ id: "docs", name: "Docs", summary: "Docs", available: true }],
            }),
      askEffect: (workspace, question) =>
        Effect.sync(() => {
          routed.push(entry.id);
          return { workspace, answer: `${entry.id}:${question}` };
        }),
      closeEffect: () => Effect.void,
    }),
  });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: "Bearer local" } },
  });
  const client = new Client({ name: "test", version: "1" });
  resources[0] = { mcp, server, client };
  await client.connect(transport as Parameters<Client["connect"]>[0]);

  expect((await client.callTool({ name: "list_lines", arguments: {} })).structuredContent).toEqual({
    lines: [
      {
        id: "line",
        available: true,
        owner: { id: "owner", name: "Owner" },
        workspaces: [{ id: "docs", name: "Docs", summary: "Docs", available: true }],
      },
      { id: "second", available: false, workspaces: [] },
    ],
  });
  await client.callTool({
    name: "ask",
    arguments: { line: "line", workspace: "docs", question: "one" },
  });
  await client.callTool({
    name: "ask",
    arguments: { line: "second", workspace: "docs", question: "two" },
  });
  expect(routed).toEqual(["line", "second"]);
});
