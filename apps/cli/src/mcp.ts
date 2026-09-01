import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import packageJson from "../package.json";
import { ColleagueLineError } from "./errors";
import type { ClientIdentity, ColleagueLine } from "./types";

interface SessionEntry {
  clientId: string;
  credentialVersion: string;
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  active: number;
  lastUsed: number;
  releaseSlot(): void;
  closed: boolean;
}

export interface McpHttpOptions {
  createServer(client: ClientIdentity): McpServer;
  authenticate(bearer: string): Promise<ClientIdentity | undefined>;
  allowedHosts: string[];
  allowedOrigins: string[];
  maxBodyBytes?: number;
  bodyTimeoutMs?: number;
  maxSessions?: number;
  maxClientSessions?: number;
  maxActiveRequests?: number;
  maxClientActiveRequests?: number;
  sessionIdleMs?: number;
  closeTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  fatal?(error: Error): void;
}

export interface McpGatewayOptions extends Omit<McpHttpOptions, "createServer"> {
  app: ColleagueLine;
}

export interface McpGateway {
  fetch(request: Request): Promise<Response>;
  closeClient(clientId: string): Promise<void>;
  close(): Promise<void>;
}

export function createMcpGateway(options: McpGatewayOptions): McpGateway {
  return createMcpHttpServer({
    ...options,
    createServer: (client) => createGatewayServer(options.app, client),
  });
}

export function createMcpHttpServer(options: McpHttpOptions): McpGateway {
  const sessions = new Map<string, SessionEntry>();
  const allSessions = new Set<SessionEntry>();
  const sessionSlotsByClient = new Map<string, number>();
  const activeByClient = new Map<string, number>();
  const active = new Set<Promise<void>>();
  let sessionSlots = 0;
  let activeCount = 0;
  let closing = false;
  const timer = setInterval(
    () => {
      const cutoff = Date.now() - (options.sessionIdleMs ?? 600_000);
      for (const entry of sessions.values()) {
        if (entry.active > 0 || entry.lastUsed > cutoff) continue;
        void closeEntry(entry).catch(() => {});
      }
    },
    Math.min(options.sessionIdleMs ?? 600_000, 60_000),
  );
  timer.unref?.();

  function reserveSession(clientId: string): (() => void) | undefined {
    if (
      sessionSlots >= (options.maxSessions ?? 32) ||
      (sessionSlotsByClient.get(clientId) ?? 0) >= (options.maxClientSessions ?? 4)
    )
      return undefined;
    sessionSlots++;
    sessionSlotsByClient.set(clientId, (sessionSlotsByClient.get(clientId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      sessionSlots--;
      const remaining = (sessionSlotsByClient.get(clientId) ?? 1) - 1;
      if (remaining === 0) sessionSlotsByClient.delete(clientId);
      else sessionSlotsByClient.set(clientId, remaining);
    };
  }

  async function closeEntry(entry: SessionEntry): Promise<void> {
    if (entry.closed) return;
    entry.closed = true;
    allSessions.delete(entry);
    if (entry.transport.sessionId && sessions.get(entry.transport.sessionId) === entry)
      sessions.delete(entry.transport.sessionId);
    const closed = entry.server.close().catch(() => {});
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        closed,
        new Promise<void>((resolve) => {
          closeTimer = setTimeout(resolve, options.closeTimeoutMs ?? 1_000);
        }),
      ]);
    } finally {
      clearTimeout(closeTimer);
      entry.releaseSlot();
    }
  }

  async function closeWhere(predicate: (entry: SessionEntry) => boolean): Promise<void> {
    await Promise.all([...allSessions].filter(predicate).map((entry) => closeEntry(entry)));
  }

  async function route(
    request: Request,
    bearer: string,
    client: ClientIdentity,
  ): Promise<Response> {
    const bounded =
      request.method === "POST"
        ? await boundedRequest(
            request,
            options.maxBodyBytes ?? 64 * 1024,
            options.bodyTimeoutMs ?? 5_000,
          )
        : request;
    if (bounded instanceof Response) return bounded;
    if (closing) return jsonRpcError(503, -32_000, "Gateway is stopping");
    const refreshed = await options.authenticate(bearer);
    if (
      !refreshed ||
      refreshed.id !== client.id ||
      refreshed.credentialVersion !== client.credentialVersion
    ) {
      return Response.json(
        { error: { code: "UNAUTHORIZED", message: "Valid bearer token required" } },
        { status: 401 },
      );
    }
    const sessionId = request.headers.get("mcp-session-id");
    if (sessionId) {
      const entry = sessions.get(sessionId);
      if (!entry) return jsonRpcError(404, -32_001, "MCP session not found");
      if (entry.clientId !== client.id || entry.credentialVersion !== client.credentialVersion) {
        return jsonRpcError(403, -32_000, "MCP session belongs to another Client credential");
      }
      entry.active++;
      entry.lastUsed = Date.now();
      try {
        return await entry.transport.handleRequest(bounded, {
          authInfo: { token: bearer, clientId: client.id, scopes: [] },
        });
      } finally {
        entry.active--;
        entry.lastUsed = Date.now();
      }
    }
    if (request.method !== "POST") return jsonRpcError(400, -32_000, "MCP session is required");
    const releaseSlot = reserveSession(client.id);
    if (!releaseSlot) return jsonRpcError(429, -32_000, "BUSY: MCP session capacity reached");
    let entry: SessionEntry;
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        if (!entry.closed) sessions.set(id, entry);
      },
      onsessionclosed: (id) => {
        if (sessions.get(id) === entry) sessions.delete(id);
        entry.closed = true;
        allSessions.delete(entry);
        releaseSlot();
      },
    });
    const server = options.createServer(client);
    entry = {
      clientId: client.id,
      credentialVersion: client.credentialVersion,
      server,
      transport,
      active: 1,
      lastUsed: Date.now(),
      releaseSlot,
      closed: false,
    };
    allSessions.add(entry);
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(bounded, {
        authInfo: { token: bearer, clientId: client.id, scopes: [] },
      });
      if (!transport.sessionId) {
        await closeEntry(entry);
      }
      return response;
    } catch (error) {
      await closeEntry(entry);
      throw error;
    } finally {
      entry.active--;
      entry.lastUsed = Date.now();
    }
  }

  return {
    async fetch(request): Promise<Response> {
      const headersError = validateHeaders(request, options.allowedHosts, options.allowedOrigins);
      if (headersError) return headersError;
      const path = new URL(request.url).pathname;
      if (path === "/healthz") {
        if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
        return Response.json({ status: "ok" });
      }
      if (path !== "/mcp") return new Response("Not Found", { status: 404 });
      if (closing) return jsonRpcError(503, -32_000, "Gateway is stopping");
      const bearer = parseBearer(request.headers.get("authorization"));
      const client = bearer ? await options.authenticate(bearer) : undefined;
      if (!client)
        return Response.json(
          { error: { code: "UNAUTHORIZED", message: "Valid bearer token required" } },
          { status: 401 },
        );
      if (closing) return jsonRpcError(503, -32_000, "Gateway is stopping");
      if (
        activeCount >= (options.maxActiveRequests ?? 64) ||
        (activeByClient.get(client.id) ?? 0) >= (options.maxClientActiveRequests ?? 16)
      ) {
        return jsonRpcError(429, -32_000, "BUSY: MCP request capacity reached");
      }
      activeCount++;
      activeByClient.set(client.id, (activeByClient.get(client.id) ?? 0) + 1);
      const operation = route(request, bearer!, client);
      const completion = operation.then(
        () => undefined,
        () => undefined,
      );
      active.add(completion);
      try {
        return await operation;
      } finally {
        active.delete(completion);
        activeCount--;
        const remaining = (activeByClient.get(client.id) ?? 1) - 1;
        if (remaining === 0) activeByClient.delete(client.id);
        else activeByClient.set(client.id, remaining);
      }
    },

    closeClient: (clientId) => closeWhere((entry) => entry.clientId === clientId),

    async close(): Promise<void> {
      closing = true;
      clearInterval(timer);
      await closeWhere(() => true);
      let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
      const drained = await Promise.race([
        Promise.all(active).then(() => true),
        new Promise<false>((resolve) => {
          shutdownTimer = setTimeout(() => resolve(false), options.shutdownTimeoutMs ?? 6_000);
        }),
      ]);
      clearTimeout(shutdownTimer);
      if (!drained) {
        const error = new Error("MCP requests did not settle during shutdown");
        options.fatal?.(error);
        throw error;
      }
    },
  };
}

async function boundedRequest(
  request: Request,
  maximum: number,
  timeoutMs: number,
): Promise<Request | Response> {
  if (
    request.headers.get("content-encoding") &&
    request.headers.get("content-encoding") !== "identity"
  ) {
    return jsonRpcError(415, -32_600, "Encoded request bodies are not supported");
  }
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    return jsonRpcError(
      Number(declared) > maximum ? 413 : 400,
      -32_600,
      "MCP request body is invalid or too large",
    );
  }
  if (!request.body) return request;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      request.signal.throwIfAborted();
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        await reader.cancel();
        return jsonRpcError(408, -32_000, "MCP request body timed out");
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          reader.read().then((value) => ({ kind: "read" as const, value })),
          new Promise<{ kind: "timeout" }>((resolve) => {
            timer = setTimeout(() => resolve({ kind: "timeout" }), remaining);
          }),
        ]);
        if (result.kind === "timeout") {
          await reader.cancel();
          return jsonRpcError(408, -32_000, "MCP request body timed out");
        }
        const { done, value } = result.value;
        if (done) break;
        size += value.byteLength;
        if (size > maximum) {
          await reader.cancel();
          return jsonRpcError(413, -32_600, "MCP request body is too large");
        }
        chunks.push(value);
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: Buffer.concat(chunks),
    signal: request.signal,
  });
}

function createGatewayServer(app: ColleagueLine, client: ClientIdentity): McpServer {
  const server = new McpServer({ name: "colleague-line", version: packageJson.version });
  server.registerTool(
    "list_workspaces",
    {
      description:
        "List this colleague's manually registered Workspaces and their public summaries.",
      outputSchema: {
        owner: z.object({ id: z.string(), name: z.string(), summary: z.string().optional() }),
        workspaces: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            summary: z.string(),
            available: z.boolean(),
          }),
        ),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => toolResult(() => app.listWorkspaces(client)),
  );
  server.registerTool(
    "ask",
    {
      description:
        "Ask this colleague a question in one exact Workspace. Later calls automatically continue the same Client and Workspace history.",
      inputSchema: {
        workspace: z.string().min(1),
        question: z.string().min(1).max(20_000),
      },
      outputSchema: { workspace: z.string(), answer: z.string() },
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async ({ workspace, question }, extra) =>
      toolResult(() => app.ask({ client, workspace, question }, extra.signal)),
  );
  return server;
}

async function toolResult<T extends object>(read: () => Promise<T>) {
  try {
    const structuredContent = (await read()) as Record<string, unknown>;
    return {
      content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
      structuredContent,
    };
  } catch (error) {
    const safe =
      error instanceof ColleagueLineError
        ? `${error.code}: ${error.message}`
        : error instanceof DOMException && error.name === "AbortError"
          ? "RUNTIME_FAILED: Request cancelled"
          : "RUNTIME_FAILED: Runtime failed";
    return { content: [{ type: "text" as const, text: safe }], isError: true };
  }
}

function parseBearer(header: string | null): string | undefined {
  const match = /^Bearer\s+(\S+)$/.exec(header ?? "");
  return match?.[1];
}

function validateHeaders(
  request: Request,
  allowedHosts: string[],
  allowedOrigins: string[],
): Response | undefined {
  const host = request.headers.get("host");
  let hostname = "";
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {}
  if (!host || (!allowedHosts.includes(host) && !allowedHosts.includes(hostname))) {
    return Response.json(
      { error: { code: "UNAUTHORIZED", message: "Invalid Host" } },
      { status: 403 },
    );
  }
  const origin = request.headers.get("origin");
  if (origin && !allowedOrigins.includes(origin)) {
    return Response.json(
      { error: { code: "UNAUTHORIZED", message: "Invalid Origin" } },
      { status: 403 },
    );
  }
  return undefined;
}

function jsonRpcError(status: number, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id: null, error: { code, message } }, { status });
}
