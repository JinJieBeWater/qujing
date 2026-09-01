import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import packageJson from "../package.json";
import type { LineConfig } from "./client-config";
import { ColleagueLineError, type ErrorCode } from "./errors";
import type { ConnectorOptions, TransportProcess } from "./transport/process";
import { startConnector } from "./transport/process";

const BOOTSTRAP_TIMEOUT_MS = 40_000;
const UPSTREAM_ASK_TIMEOUT_MS = 130_000;
const CLOSE_TIMEOUT_MS = 6_000;
const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const workspacesSchema = z.object({
  owner: z.object({ id: idSchema, name: z.string().min(1), summary: z.string().min(1).optional() }),
  workspaces: z.array(
    z.object({
      id: idSchema,
      name: z.string().min(1),
      summary: z.string().min(1),
      available: z.boolean(),
    }),
  ),
});
const askSchema = z.object({ workspace: idSchema, answer: z.string() });
const safeCodes = new Set<string>([
  "WORKSPACE_NOT_FOUND",
  "WORKSPACE_UNAVAILABLE",
  "INVALID_QUESTION",
  "RUNTIME_UNAVAILABLE",
  "RUNTIME_TIMEOUT",
  "RUNTIME_FAILED",
  "BUSY",
]);

export type LineWorkspaces = z.infer<typeof workspacesSchema>;
export type LineAskResult = z.infer<typeof askSchema>;
export interface UpstreamTransport {
  terminateSession?(): Promise<void>;
}
export interface UpstreamClient {
  connect(transport: unknown, options?: { signal?: AbortSignal; timeout?: number }): Promise<void>;
  callTool(
    params: { name: string; arguments: Record<string, unknown> },
    schema?: unknown,
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}
export interface LineRuntimeOptions {
  line: LineConfig;
  startConnector?: (options: ConnectorOptions, signal?: AbortSignal) => Promise<TransportProcess>;
  createUpstream?: (
    url: URL,
    bearer: string,
  ) => { client: UpstreamClient; transport: UpstreamTransport };
}

interface Session {
  connector: TransportProcess;
  client: UpstreamClient;
  transport: UpstreamTransport;
}
interface PendingSession {
  promise: Promise<Session>;
  controller: AbortController;
  waiters: number;
}

export class LineRuntime {
  private session: Session | undefined;
  private pending: PendingSession | undefined;
  private closed = false;
  private readonly start: (
    options: ConnectorOptions,
    signal?: AbortSignal,
  ) => Promise<TransportProcess>;
  private readonly createUpstream: (
    url: URL,
    bearer: string,
  ) => { client: UpstreamClient; transport: UpstreamTransport };

  constructor(private readonly options: LineRuntimeOptions) {
    this.start =
      options.startConnector ??
      ((connector, signal) => startConnector(connector, undefined, signal));
    this.createUpstream =
      options.createUpstream ??
      ((url, bearer) => {
        const transport = new StreamableHTTPClientTransport(url, {
          requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
        });
        return {
          client: new Client({
            name: "colleague-line-client",
            version: packageJson.version,
          }) as unknown as UpstreamClient,
          transport,
        };
      });
  }

  async listWorkspaces(signal?: AbortSignal): Promise<LineWorkspaces> {
    const session = await this.getSession(signal);
    try {
      const result = await session.client.callTool(
        { name: "list_workspaces", arguments: {} },
        undefined,
        requestOptions(signal, BOOTSTRAP_TIMEOUT_MS),
      );
      return this.verifiedWorkspaces(result);
    } catch (error) {
      if (isAbort(error)) throw error;
      await this.drop(session);
      throw this.safeFailure(error);
    }
  }

  async ask(workspace: string, question: string, signal?: AbortSignal): Promise<LineAskResult> {
    signal?.throwIfAborted();
    const session = await this.getSession(signal);
    try {
      const result = await session.client.callTool(
        { name: "ask", arguments: { workspace, question } },
        undefined,
        requestOptions(signal, UPSTREAM_ASK_TIMEOUT_MS),
      );
      return this.result(result, askSchema);
    } catch (error) {
      if (isAbort(error) || error instanceof ColleagueLineError) throw error;
      await this.drop(session);
      throw this.safeFailure(error);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const session = this.session;
    this.session = undefined;
    const pending = this.pending;
    pending?.controller.abort();
    if (session) await this.dispose(session);
    await pending?.promise.then((created) => this.dispose(created)).catch(() => {});
  }

  private async getSession(signal?: AbortSignal): Promise<Session> {
    signal?.throwIfAborted();
    if (this.closed) throw new ColleagueLineError("LINE_UNAVAILABLE", "Line unavailable");
    if (this.session) return this.session;
    if (!this.pending) {
      const controller = new AbortController();
      const pending = { controller, waiters: 0 } as PendingSession;
      pending.promise = this.createSession(controller.signal).finally(() => {
        if (this.pending === pending) this.pending = undefined;
      });
      this.pending = pending;
    }
    const pending = this.pending;
    pending.waiters++;
    try {
      return await waitFor(pending.promise, signal);
    } finally {
      pending.waiters--;
      if (pending.waiters === 0 && this.pending === pending && !this.session)
        pending.controller.abort();
    }
  }

  private async createSession(signal: AbortSignal): Promise<Session> {
    let connector: TransportProcess | undefined;
    let client: UpstreamClient | undefined;
    let transport: UpstreamTransport | undefined;
    try {
      connector = await this.start(
        {
          serverAddress: this.options.line.serverAddress,
          remotePort: this.options.line.remotePort,
          keyPath: this.options.line.keyPath,
          localHost: "127.0.0.1",
          localPort: 0,
        },
        signal,
      );
      if (!connector.ready.localAddress) throw new Error("Connector did not provide local address");
      const upstream = this.createUpstream(
        new URL(`http://${connector.ready.localAddress}/mcp`),
        this.options.line.remoteBearer,
      );
      client = upstream.client;
      transport = upstream.transport;
      await client.connect(transport, { signal, timeout: BOOTSTRAP_TIMEOUT_MS });
      const result = await client.callTool({ name: "list_workspaces", arguments: {} }, undefined, {
        signal,
        timeout: BOOTSTRAP_TIMEOUT_MS,
      });
      this.verifiedWorkspaces(result);
      signal.throwIfAborted();
      const session = { connector, client, transport };
      if (this.closed) {
        await this.dispose(session);
        throw new Error("Line closed");
      }
      this.session = session;
      return session;
    } catch (error) {
      if (transport?.terminateSession) await transport.terminateSession().catch(() => {});
      if (client) await client.close().catch(() => {});
      if (connector) await connector.close().catch(() => {});
      throw this.safeFailure(error);
    }
  }

  private verifiedWorkspaces(result: Record<string, unknown>): LineWorkspaces {
    const workspaces = this.result(result, workspacesSchema);
    if (workspaces.owner.id !== this.options.line.expectedOwnerId)
      throw new ColleagueLineError("OWNER_ID_MISMATCH", "Owner identity mismatch");
    return workspaces;
  }

  private result<T>(result: Record<string, unknown>, schema: z.ZodType<T>): T {
    if (result.isError) throw this.gatewayFailure(result);
    const parsed = schema.safeParse(result.structuredContent);
    if (!parsed.success) throw new Error("Invalid upstream response");
    return parsed.data;
  }

  private gatewayFailure(result: Record<string, unknown>): ColleagueLineError {
    const structured = z.object({ code: z.string() }).safeParse(result.structuredContent)
      .data?.code;
    const text = Array.isArray(result.content)
      ? result.content.find(
          (item): item is { type: "text"; text: string } =>
            !!item &&
            typeof item === "object" &&
            (item as { type?: unknown }).type === "text" &&
            typeof (item as { text?: unknown }).text === "string",
        )?.text
      : undefined;
    const textual = /^([A-Z_]+):/.exec(text ?? "")?.[1];
    const code = structured ?? textual;
    return new ColleagueLineError(
      safeCodes.has(code ?? "") ? (code as ErrorCode) : "RUNTIME_FAILED",
      "Remote request failed",
    );
  }

  private safeFailure(error: unknown): ColleagueLineError {
    return error instanceof ColleagueLineError
      ? error
      : new ColleagueLineError("LINE_UNAVAILABLE", "Line unavailable");
  }

  private async drop(session: Session): Promise<void> {
    if (this.session === session) this.session = undefined;
    await this.dispose(session);
  }

  private async dispose(session: Session): Promise<void> {
    const closing = (async () => {
      await session.transport.terminateSession?.().catch(() => {});
      await Promise.allSettled([session.client.close(), session.connector.close()]);
    })();
    await boundedClose(closing);
  }
}

function requestOptions(signal: AbortSignal | undefined, timeout: number) {
  return signal ? { signal, timeout } : { timeout };
}

function isAbort(error: unknown): error is DOMException {
  return error instanceof DOMException && error.name === "AbortError";
}

async function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function boundedClose(closing: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    closing,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
}
