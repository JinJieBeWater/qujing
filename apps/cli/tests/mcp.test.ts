import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ColleagueLine } from "../src/types";
import { createMcpGateway, type McpGateway, type McpGatewayOptions } from "../src/mcp";

const resources: Array<{
  gateway: McpGateway;
  server: ReturnType<typeof Bun.serve>;
  client?: Client;
}> = [];

afterEach(async () => {
  await Promise.all(
    resources.splice(0).map(async ({ client, gateway, server }) => {
      if (client) await Promise.race([client.close().catch(() => {}), Bun.sleep(100)]);
      await Promise.race([Promise.resolve(server.stop(true)), Bun.sleep(100)]);
      await Promise.race([gateway.close().catch(() => {}), Bun.sleep(100)]);
    }),
  );
});

async function fixture(app?: ColleagueLine, overrides: Partial<McpGatewayOptions> = {}) {
  const application: ColleagueLine = app ?? {
    listWorkspaces: async () => ({
      owner: { id: "owner", name: "Owner" },
      workspaces: [{ id: "docs", name: "Docs", summary: "Docs", available: true }],
    }),
    ask: async ({ workspace, question }) => ({ workspace, answer: `answer:${question}` }),
  };
  let gateway!: McpGateway;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => gateway.fetch(request),
  });
  gateway = createMcpGateway({
    app: application,
    authenticate: async (bearer) =>
      bearer === "first-token"
        ? { id: "first", credentialVersion: "first-version" }
        : bearer === "rotated-token"
          ? { id: "first", credentialVersion: "rotated-version" }
          : bearer === "second-token"
            ? { id: "second", credentialVersion: "second-version" }
            : undefined,
    allowedHosts: ["127.0.0.1"],
    allowedOrigins: [],
    ...overrides,
  });
  resources.push({ gateway, server });
  return { gateway, server, url: new URL(`http://127.0.0.1:${server.port}/mcp`) };
}

describe("MCP gateway", () => {
  test("exposes exactly list_workspaces and ask with structured and text results", async () => {
    const { gateway, server, url } = await fixture();
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: "Bearer first-token" } },
    });
    const client = new Client({ name: "test", version: "1" });
    resources[0] = { gateway, server, client };
    await client.connect(transport as Parameters<Client["connect"]>[0]);

    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name)).toEqual(["list_workspaces", "ask"]);
    expect(tools.find((tool) => tool.name === "ask")?.annotations).toEqual({
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
    const listed = await client.callTool({ name: "list_workspaces", arguments: {} });
    expect(listed.structuredContent).toMatchObject({
      owner: { id: "owner" },
      workspaces: [{ id: "docs" }],
    });
    expect(listed.content).toEqual([
      { type: "text", text: JSON.stringify(listed.structuredContent) },
    ]);
    const asked = await client.callTool({
      name: "ask",
      arguments: { workspace: "docs", question: "hello" },
    });
    expect(asked.structuredContent).toEqual({ workspace: "docs", answer: "answer:hello" });
  });

  test("authenticates every request and binds MCP sessions to one Client", async () => {
    const { gateway, server, url } = await fixture();
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: "Bearer first-token" } },
    });
    const client = new Client({ name: "test", version: "1" });
    resources[0] = { gateway, server, client };
    await client.connect(transport as Parameters<Client["connect"]>[0]);

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

  test("rejects a bearer that becomes invalid after MCP initialization", async () => {
    let active = true;
    const { gateway, server, url } = await fixture(undefined, {
      authenticate: async (bearer) =>
        active && bearer === "first-token"
          ? { id: "first", credentialVersion: "first-version" }
          : undefined,
    });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: "Bearer first-token" } },
    });
    const client = new Client({ name: "test", version: "1" });
    resources[0] = { gateway, server, client };
    await client.connect(transport as Parameters<Client["connect"]>[0]);
    active = false;

    await expect(client.listTools()).rejects.toBeDefined();
  });

  test("bounds request bodies with and without Content-Length", async () => {
    const { gateway, url } = await fixture(undefined, { maxBodyBytes: 128, bodyTimeoutMs: 20 });
    const headers = {
      Authorization: "Bearer first-token",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    const declared = await fetch(url, { method: "POST", headers, body: "x".repeat(129) });
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
    const encoded = await gateway.fetch(
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
    const timedOut = await gateway.fetch(
      new Request(url.href, {
        method: "POST",
        headers: { ...headers, Host: "127.0.0.1" },
        body: stalled,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );
    expect(timedOut.status).toBe(408);
  });

  test("enforces hard global and per-Client MCP session capacity", async () => {
    const { gateway, server, url } = await fixture(undefined, {
      maxSessions: 1,
      maxClientSessions: 1,
    });
    const firstTransport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: "Bearer first-token" } },
    });
    const first = new Client({ name: "first", version: "1" });
    resources[0] = { gateway, server, client: first };
    await first.connect(firstTransport as Parameters<Client["connect"]>[0]);
    const secondTransport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: "Bearer first-token" } },
    });
    const second = new Client({ name: "second", version: "1" });

    await expect(
      second.connect(secondTransport as Parameters<Client["connect"]>[0]),
    ).rejects.toBeDefined();
    await second.close().catch(() => {});
    await gateway.closeClient("first");
    const replacementTransport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: "Bearer first-token" } },
    });
    const replacement = new Client({ name: "replacement", version: "1" });
    await expect(
      replacement.connect(replacementTransport as Parameters<Client["connect"]>[0]),
    ).resolves.toBeUndefined();
    await replacement.close();
  });

  test("bounds concurrent requests independently from session slots", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app: ColleagueLine = {
      listWorkspaces: async () => ({ owner: { id: "owner", name: "Owner" }, workspaces: [] }),
      ask: async ({ workspace }) => {
        await blocked;
        return { workspace, answer: "done" };
      },
    };
    const { gateway, server, url } = await fixture(app, {
      maxActiveRequests: 1,
      maxClientActiveRequests: 1,
    });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: "Bearer first-token" } },
    });
    const client = new Client({ name: "test", version: "1" });
    resources[0] = { gateway, server, client };
    await client.connect(transport as Parameters<Client["connect"]>[0]);
    const pending = client.callTool({
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
    const badOrigin = await fetch(url, { headers: { Origin: "https://evil.example" } });
    expect(badOrigin.status).toBe(403);
    const connectorHost = await fetch(new URL("/healthz", url), {
      headers: { Host: "127.0.0.1:49999" },
    });
    expect(connectorHost.status).toBe(200);
  });

  test("propagates MCP cancellation to ask", async () => {
    let cancelled = false;
    const app: ColleagueLine = {
      listWorkspaces: async () => ({ owner: { id: "owner", name: "Owner" }, workspaces: [] }),
      ask: async (_request, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              cancelled = true;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    };
    const { gateway, server, url } = await fixture(app);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: "Bearer first-token" } },
    });
    const client = new Client({ name: "test", version: "1" });
    resources[0] = { gateway, server, client };
    await client.connect(transport as Parameters<Client["connect"]>[0]);
    const controller = new AbortController();
    const pending = client.callTool(
      { name: "ask", arguments: { workspace: "docs", question: "wait" } },
      undefined,
      { signal: controller.signal },
    );
    await Bun.sleep(10);

    controller.abort();

    await expect(pending).rejects.toBeDefined();
    await Bun.sleep(10);
    expect(cancelled).toBe(true);
  });

  test("fails shutdown after a bounded drain when an active handler ignores cancellation", async () => {
    let fatal: Error | undefined;
    const app: ColleagueLine = {
      listWorkspaces: async () => ({ owner: { id: "owner", name: "Owner" }, workspaces: [] }),
      ask: async () => new Promise(() => {}),
    };
    const { gateway, server, url } = await fixture(app, {
      closeTimeoutMs: 10,
      shutdownTimeoutMs: 20,
      fatal: (error) => {
        fatal = error;
      },
    });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: "Bearer first-token" } },
    });
    const client = new Client({ name: "test", version: "1" });
    resources[0] = { gateway, server, client };
    await client.connect(transport as Parameters<Client["connect"]>[0]);
    const pending = client.callTool({
      name: "ask",
      arguments: { workspace: "docs", question: "never" },
    });
    void pending.catch(() => {});
    await Bun.sleep(10);

    await expect(gateway.close()).rejects.toThrow("did not settle");
    expect(fatal?.message).toContain("did not settle");
  });
});
