import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, test } from "bun:test";
import { AgentApplication, type PeerRuntimeAgent } from "../src/agent-application";
import type { AgentConfig, PeerConfig } from "../src/agent-config";
import { createAgentMcp, type AgentMcpOptions } from "../src/agent-mcp";
import { QujingError } from "../src/errors";
import type { McpHttpServer } from "../src/mcp";
import { Effect } from "effect";

const resources: Array<{
  mcp: McpHttpServer;
  server: ReturnType<typeof Bun.serve>;
  agent?: Client;
}> = [];
afterEach(async () => {
  await Promise.all(
    resources.splice(0).map(async ({ mcp, server, agent }) => {
      server.stop(true);
      await Promise.all([
        Promise.race([agent?.close().catch(() => {}), Bun.sleep(100)]),
        Promise.race([Effect.runPromise(mcp.closeEffect).catch(() => {}), Bun.sleep(100)]),
      ]);
    }),
  );
});

const now = new Date().toISOString();
const peer: PeerConfig = {
  id: "peer",
  expectedNodeId: "node",
  remoteAgentId: "remote",
  serverAddress: "private",
  remotePort: 1,
  keyPath: "/key",
  remoteBearer: "secret",
  createdAt: now,
  updatedAt: now,
};

function fixture(
  options: {
    config?: AgentConfig;
    createRuntime?: (peer: PeerConfig) => PeerRuntimeAgent;
  } = {},
) {
  const config: AgentConfig = options.config ?? {
    version: 1,
    server: { host: "127.0.0.1", port: 1 },
    localBearerHash: "a".repeat(64),
    peers: [peer],
  };
  const app = new AgentApplication({
    config: { readEffect: () => Effect.succeed(config) },
    createRuntime:
      options.createRuntime ??
      (() => ({
        listWorkspacesEffect: () =>
          Effect.succeed({ node: { id: "node", name: "Node" }, workspaces: [] }),
        askEffect: (workspace, question) =>
          Effect.succeed({ workspace, answer: `answer:${question}` }),
        closeEffect: () => Effect.void,
      })),
  });
  let mcp!: McpHttpServer;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => mcp.fetch(request),
  });
  mcp = createAgentMcp({
    app,
    config: {
      authenticateLocalEffect: (bearer) =>
        Effect.succeed(
          bearer === "local" ? { id: "local-agent", credentialVersion: "v1" } : undefined,
        ),
    },
    allowedHosts: ["127.0.0.1"],
    allowedOrigins: [],
  } satisfies AgentMcpOptions);
  resources.push({ mcp, server });
  return { mcp, server, url: new URL(`http://127.0.0.1:${server.port}/mcp`) };
}

test("Agent MCP exposes only Agent tools with local auth", async () => {
  const { mcp, server, url } = fixture();
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: "Bearer local" } },
  });
  const agent = new Client({ name: "test", version: "1" });
  resources[0] = { mcp, server, agent };
  await agent.connect(transport as Parameters<Client["connect"]>[0]);
  const tools = (await agent.listTools()).tools;
  expect(tools.map(({ name }) => name)).toEqual(["list_peers", "ask"]);
  expect(tools.find(({ name }) => name === "list_peers")?.annotations).toEqual({
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
  const listed = await agent.callTool({ name: "list_peers", arguments: {} });
  expect(listed.structuredContent).toEqual({
    peers: [{ id: "peer", available: true, node: { id: "node", name: "Node" }, workspaces: [] }],
  });
  expect(listed.content).toEqual([
    { type: "text", text: JSON.stringify(listed.structuredContent) },
  ]);
  expect(
    await agent.callTool({
      name: "ask",
      arguments: { peer: "peer", workspace: "ws", question: "q" },
    }),
  ).toMatchObject({ structuredContent: { peer: "peer", workspace: "ws", answer: "answer:q" } });
  const stale = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer old", "content-type": "application/json" },
    body: "{}",
  });
  expect(stale.status).toBe(401);
});

test("Agent MCP cancellation reaches the selected Peer runtime", async () => {
  let cancelled = false;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let markCancelled!: () => void;
  const cancellationObserved = new Promise<void>((resolve) => {
    markCancelled = resolve;
  });
  const config: AgentConfig = {
    version: 1,
    server: { host: "127.0.0.1", port: 1 },
    localBearerHash: "a".repeat(64),
    peers: [peer],
  };
  const app = new AgentApplication({
    config: { readEffect: () => Effect.succeed(config) },
    createRuntime: () =>
      ({
        listWorkspacesEffect: () =>
          Effect.succeed({ node: { id: "node", name: "Node" }, workspaces: [] }),
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
      }) satisfies PeerRuntimeAgent,
  });
  let mcp!: McpHttpServer;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => mcp.fetch(request),
  });
  mcp = createAgentMcp({
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
    {
      requestInit: { headers: { Authorization: "Bearer local" } },
    },
  );
  const agent = new Client({ name: "test", version: "1" });
  resources.push({ mcp, server, agent });
  await agent.connect(transport as Parameters<Client["connect"]>[0]);
  const controller = new AbortController();
  const pending = agent.callTool(
    { name: "ask", arguments: { peer: "peer", workspace: "ws", question: "wait" } },
    undefined,
    { signal: controller.signal },
  );
  await started;
  controller.abort();

  await expect(pending).rejects.toBeDefined();
  await cancellationObserved;
  expect(cancelled).toBe(true);
});

test("forwards raw questions to the Node Peer for domain validation", async () => {
  let received: string | undefined;
  const { mcp, server, url } = fixture({
    createRuntime: () => ({
      listWorkspacesEffect: () =>
        Effect.succeed({ node: { id: "node", name: "Node" }, workspaces: [] }),
      askEffect: (_workspace, question) =>
        Effect.sync(() => {
          received = question;
          throw new QujingError("INVALID_QUESTION", "Remote request failed");
        }),
      closeEffect: () => Effect.void,
    }),
  });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: "Bearer local" } },
  });
  const agent = new Client({ name: "test", version: "1" });
  resources[0] = { mcp, server, agent };
  await agent.connect(transport as Parameters<Client["connect"]>[0]);

  const result = await agent.callTool({
    name: "ask",
    arguments: { peer: "peer", workspace: "ws", question: "   " },
  });

  expect(received).toBe("   ");
  expect(result).toMatchObject({ isError: true });
});

test("Agent MCP lists two Peers independently and routes each ask exactly", async () => {
  const second = {
    ...peer,
    id: "second",
    expectedNodeId: "node-second",
    remoteAgentId: "remote-second",
    remoteBearer: "secret-second",
  };
  const config: AgentConfig = {
    version: 1,
    server: { host: "127.0.0.1", port: 1 },
    localBearerHash: "a".repeat(64),
    peers: [peer, second],
  };
  const routed: string[] = [];
  const { mcp, server, url } = fixture({
    config,
    createRuntime: (entry) => ({
      listWorkspacesEffect: () =>
        entry.id === "second"
          ? Effect.fail(new Error("offline"))
          : Effect.succeed({
              node: { id: entry.expectedNodeId, name: "Node" },
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
  const agent = new Client({ name: "test", version: "1" });
  resources[0] = { mcp, server, agent };
  await agent.connect(transport as Parameters<Client["connect"]>[0]);

  expect((await agent.callTool({ name: "list_peers", arguments: {} })).structuredContent).toEqual({
    peers: [
      {
        id: "peer",
        available: true,
        node: { id: "node", name: "Node" },
        workspaces: [{ id: "docs", name: "Docs", summary: "Docs", available: true }],
      },
      { id: "second", available: false, workspaces: [] },
    ],
  });
  await agent.callTool({
    name: "ask",
    arguments: { peer: "peer", workspace: "docs", question: "one" },
  });
  await agent.callTool({
    name: "ask",
    arguments: { peer: "second", workspace: "docs", question: "two" },
  });
  expect(routed).toEqual(["peer", "second"]);
});
