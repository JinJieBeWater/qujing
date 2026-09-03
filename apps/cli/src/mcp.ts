import {
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Logger,
  Ref,
  Schema,
  Scope,
  Semaphore,
} from "effect";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/unstable/ai";
import { HttpRouter } from "effect/unstable/http";
import packageJson from "../package.json";
import { QujingError } from "./errors";
import { LineAskResult, LineWorkspaces, NonEmptyString, type ClientIdentity } from "./schemas";
import type { QujingEffectApi } from "./qujing";

interface SessionEntry {
  clientId: string;
  credentialVersion: string;
  server: EffectMcpSession;
  requests: Map<string, AbortController>;
}

interface SessionState {
  active: number;
  lastUsed: number;
}

interface RequestLease {
  clientId: string;
  settled: Deferred.Deferred<void>;
}

interface State {
  sessions: Map<string, SessionEntry>;
  entries: Map<SessionEntry, SessionState>;
  sessionSlotsByClient: Map<string, number>;
  activeByClient: Map<string, number>;
  active: Set<RequestLease>;
  sessionSlots: number;
  closing: boolean;
}

export interface McpHttpOptions {
  createServer(client: ClientIdentity): EffectMcpSession;
  authenticateEffect(bearer: string): Effect.Effect<ClientIdentity | undefined, unknown>;
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
  app: QujingEffectApi;
}

export interface McpGateway {
  fetch(request: Request): Promise<Response>;
  closeClientEffect(clientId: string): Effect.Effect<void, Error>;
  closeEffect: Effect.Effect<void, Error>;
}

export interface EffectMcpSession {
  handle(request: Request): Promise<Response>;
  close(): Promise<void>;
}

export class McpToolFailure extends Schema.Error<McpToolFailure>("qujing/McpToolFailure")({
  message: Schema.String,
}) {}

export function createEffectMcpSession(
  name: string,
  registrations: Layer.Layer<never, never, McpServer.McpServer>,
  allowedOrigins: readonly string[],
): EffectMcpSession {
  const app = registrations.pipe(
    Layer.provideMerge(
      McpServer.layerHttp({
        name,
        version: packageJson.version,
        path: "/mcp",
        protocols: [
          McpProtocol.v2025_11_25,
          McpProtocol.v2025_06_18,
          McpProtocol.v2025_03_26,
          McpProtocol.v2024_11_05,
        ],
        allowedOrigins,
      }),
    ),
    Layer.provide(Logger.layer([])),
  );
  const handler = HttpRouter.toWebHandler(app, { disableLogger: true });
  return { handle: handler.handler, close: handler.dispose };
}

export function withAbortSignal<A, E, R>(
  run: (signal: AbortSignal) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.sync(() => new AbortController()),
    (controller) => run(controller.signal),
    (controller) => Effect.sync(() => controller.abort(new DOMException("Aborted", "AbortError"))),
  );
}

export function createMcpGateway(options: McpGatewayOptions): McpGateway {
  return createMcpHttpServer({
    ...options,
    createServer: (client) => createGatewayServer(options.app, client, options.allowedOrigins),
  });
}

export function createMcpHttpServer(options: McpHttpOptions): McpGateway {
  const gate = Effect.runSync(Semaphore.make(1));
  const state = Effect.runSync(
    Ref.make<State>({
      sessions: new Map(),
      entries: new Map(),
      sessionSlotsByClient: new Map(),
      activeByClient: new Map(),
      active: new Set(),
      sessionSlots: 0,
      closing: false,
    }),
  );
  const scope = Effect.runSync(Scope.make("sequential"));

  const withGate = <A, E, R>(effect: Effect.Effect<A, E, R>) => gate.withPermit(effect);
  const isClosing = Ref.get(state).pipe(Effect.map((current) => current.closing));
  const releaseEntry = (entry: SessionEntry) =>
    withGate(
      Ref.modify(state, (current): readonly [boolean, State] => {
        if (!current.entries.has(entry)) return [false, current] as const;
        const entries = new Map(current.entries);
        entries.delete(entry);
        const sessions = new Map(
          [...current.sessions].filter(([, candidate]) => candidate !== entry),
        );
        const sessionSlotsByClient = new Map(current.sessionSlotsByClient);
        const remaining = (sessionSlotsByClient.get(entry.clientId) ?? 1) - 1;
        if (remaining === 0) sessionSlotsByClient.delete(entry.clientId);
        else sessionSlotsByClient.set(entry.clientId, remaining);
        return [
          true,
          {
            ...current,
            entries,
            sessions,
            sessionSlotsByClient,
            sessionSlots: current.sessionSlots - 1,
          },
        ] as const;
      }),
    );
  const closeEntry = (entry: SessionEntry) =>
    releaseEntry(entry).pipe(
      Effect.flatMap((released) =>
        released
          ? abortEntryRequests(entry).pipe(
              Effect.andThen(
                Effect.tryPromise({
                  try: entry.server.close,
                  catch: () => undefined,
                }),
              ),
              Effect.timeout(Duration.millis(options.closeTimeoutMs ?? 1_000)),
              Effect.asVoid,
            )
          : Effect.void,
      ),
    );
  const closeWhere = (
    predicate: (entry: SessionEntry, session: SessionState) => boolean,
    abortRequests = false,
  ) =>
    withGate(
      Ref.modify(state, (current): readonly [SessionEntry[], State] => {
        const selected = [...current.entries].filter(([entry, session]) =>
          predicate(entry, session),
        );
        if (selected.length === 0) return [[], current];
        const entries = new Map(current.entries);
        const sessions = new Map(current.sessions);
        const sessionSlotsByClient = new Map(current.sessionSlotsByClient);
        for (const [entry] of selected) {
          entries.delete(entry);
          for (const [id, candidate] of sessions) if (candidate === entry) sessions.delete(id);
          const remaining = (sessionSlotsByClient.get(entry.clientId) ?? 1) - 1;
          if (remaining === 0) sessionSlotsByClient.delete(entry.clientId);
          else sessionSlotsByClient.set(entry.clientId, remaining);
        }
        return [
          selected.map(([entry]) => entry),
          {
            ...current,
            entries,
            sessions,
            sessionSlotsByClient,
            sessionSlots: current.sessionSlots - selected.length,
          },
        ];
      }),
    ).pipe(Effect.flatMap((entries) => closeEntriesEffect(entries, abortRequests)));

  const closeEntriesEffect = (entries: ReadonlyArray<SessionEntry>, abortRequests = false) =>
    Effect.all(
      entries.map((entry) =>
        (abortRequests ? abortEntryRequests(entry) : Effect.void).pipe(
          Effect.andThen(
            Effect.tryPromise({
              try: entry.server.close,
              catch: () => undefined,
            }),
          ),
        ),
      ),
      { concurrency: "unbounded" },
    ).pipe(
      Effect.timeout(Duration.millis(options.closeTimeoutMs ?? 1_000)),
      Effect.asVoid,
      Effect.catchEager(() => Effect.void),
    );

  Effect.runSync(
    Effect.sleep(Duration.millis(Math.min(options.sessionIdleMs ?? 600_000, 60_000))).pipe(
      Effect.andThen(() => {
        const cutoff = Date.now() - (options.sessionIdleMs ?? 600_000);
        return closeWhere((_entry, session) => session.active === 0 && session.lastUsed <= cutoff);
      }),
      Effect.forever,
      Effect.forkIn(scope, { startImmediately: true }),
    ),
  );

  const handleRouteEffect = (request: Request, bearer: string, client: ClientIdentity) =>
    Effect.gen(function* () {
      const bounded =
        request.method === "POST"
          ? yield* boundedRequestEffect(
              request,
              options.maxBodyBytes ?? 64 * 1024,
              options.bodyTimeoutMs ?? 5_000,
            )
          : request;
      if (bounded instanceof Response) return bounded;
      if (yield* isClosing) return jsonRpcError(503, -32_000, "Gateway is stopping");
      const refreshed = yield* options.authenticateEffect(bearer);
      if (
        !refreshed ||
        refreshed.id !== client.id ||
        refreshed.credentialVersion !== client.credentialVersion
      )
        return Response.json(
          {
            error: {
              code: "UNAUTHORIZED",
              message: "Valid bearer token required",
            },
          },
          { status: 401 },
        );
      const sessionId = request.headers.get("mcp-session-id");
      if (sessionId) {
        const admitted = yield* withGate(
          Ref.modify(state, (current): readonly [SessionEntry | Response, State] => {
            const entry = current.sessions.get(sessionId);
            if (!entry) return [jsonRpcError(404, -32_001, "MCP session not found"), current];
            if (
              entry.clientId !== client.id ||
              entry.credentialVersion !== client.credentialVersion
            )
              return [
                jsonRpcError(403, -32_000, "MCP session belongs to another Client credential"),
                current,
              ];
            const entries = new Map(current.entries);
            const session = entries.get(entry);
            if (!session) return [jsonRpcError(404, -32_001, "MCP session not found"), current];
            entries.set(entry, {
              active: session.active + 1,
              lastUsed: Date.now(),
            });
            return [entry, { ...current, entries }];
          }),
        );
        if (admitted instanceof Response) return admitted;
        if (request.method === "DELETE")
          return yield* closeEntry(admitted).pipe(Effect.as(new Response(null, { status: 204 })));
        return yield* handleSessionRequest(admitted, bounded).pipe(
          Effect.ensuring(
            withGate(
              Ref.update(state, (current) => {
                const session = current.entries.get(admitted);
                if (!session) return current;
                return {
                  ...current,
                  entries: new Map(current.entries).set(admitted, {
                    active: session.active - 1,
                    lastUsed: Date.now(),
                  }),
                };
              }),
            ),
          ),
        );
      }
      if (request.method !== "POST") return jsonRpcError(400, -32_000, "MCP session is required");
      const entry: SessionEntry = {
        clientId: client.id,
        credentialVersion: client.credentialVersion,
        server: options.createServer(client),
        requests: new Map(),
      };
      const reserved = yield* withGate(
        Ref.modify(state, (current) => {
          if (
            current.closing ||
            current.sessionSlots >= (options.maxSessions ?? 32) ||
            (current.sessionSlotsByClient.get(client.id) ?? 0) >= (options.maxClientSessions ?? 4)
          )
            return [false, current] as const;
          return [
            true,
            {
              ...current,
              entries: new Map(current.entries).set(entry, {
                active: 1,
                lastUsed: Date.now(),
              }),
              sessionSlotsByClient: new Map(current.sessionSlotsByClient).set(
                client.id,
                (current.sessionSlotsByClient.get(client.id) ?? 0) + 1,
              ),
              sessionSlots: current.sessionSlots + 1,
            },
          ] as const;
        }),
      );
      if (!reserved)
        return yield* Effect.tryPromise({
          try: entry.server.close,
          catch: () => undefined,
        }).pipe(Effect.as(jsonRpcError(429, -32_000, "BUSY: MCP session capacity reached")));
      return yield* handleSessionRequest(entry, bounded).pipe(
        Effect.flatMap((response) => {
          const id = response.headers.get("mcp-session-id");
          return id
            ? withGate(
                Ref.update(state, (current) =>
                  current.entries.has(entry)
                    ? {
                        ...current,
                        sessions: new Map(current.sessions).set(id, entry),
                      }
                    : current,
                ),
              ).pipe(Effect.as(response))
            : closeEntry(entry).pipe(Effect.as(response));
        }),
        Effect.tapError(() => closeEntry(entry)),
        Effect.ensuring(
          withGate(
            Ref.update(state, (current) => {
              const session = current.entries.get(entry);
              return session
                ? {
                    ...current,
                    entries: new Map(current.entries).set(entry, {
                      active: session.active - 1,
                      lastUsed: Date.now(),
                    }),
                  }
                : current;
            }),
          ),
        ),
      );
    });

  const routeEffect = (request: Request) =>
    Effect.gen(function* () {
      const headersError = validateHeaders(request, options.allowedHosts, options.allowedOrigins);
      if (headersError) return headersError;
      const path = new URL(request.url).pathname;
      if (path === "/healthz") {
        if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
        return Response.json({ status: "ok" });
      }
      if (path !== "/mcp") return new Response("Not Found", { status: 404 });
      if (yield* isClosing) return jsonRpcError(503, -32_000, "Gateway is stopping");
      const bearer = parseBearer(request.headers.get("authorization"));
      const client = bearer ? yield* options.authenticateEffect(bearer) : undefined;
      if (!client)
        return Response.json(
          {
            error: {
              code: "UNAUTHORIZED",
              message: "Valid bearer token required",
            },
          },
          { status: 401 },
        );
      const lease = yield* withGate(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (
            current.closing ||
            current.active.size >= (options.maxActiveRequests ?? 64) ||
            (current.activeByClient.get(client.id) ?? 0) >= (options.maxClientActiveRequests ?? 16)
          )
            return;
          const lease = {
            clientId: client.id,
            settled: yield* Deferred.make<void>(),
          };
          yield* Ref.set(state, {
            ...current,
            active: new Set(current.active).add(lease),
            activeByClient: new Map(current.activeByClient).set(
              client.id,
              (current.activeByClient.get(client.id) ?? 0) + 1,
            ),
          });
          return lease;
        }),
      );
      if (!lease) return jsonRpcError(429, -32_000, "BUSY: MCP request capacity reached");
      const finishLease = withGate(
        Deferred.succeed(lease.settled, undefined).pipe(
          Effect.andThen(
            Ref.update(state, (current) => {
              const active = new Set(current.active);
              active.delete(lease);
              const activeByClient = new Map(current.activeByClient);
              const remaining = (activeByClient.get(client.id) ?? 1) - 1;
              if (remaining === 0) activeByClient.delete(client.id);
              else activeByClient.set(client.id, remaining);
              return { ...current, active, activeByClient };
            }),
          ),
        ),
      );
      return yield* handleRouteEffect(request, bearer!, client).pipe(Effect.ensuring(finishLease));
    });

  const closeEffect = Effect.gen(function* () {
    const active = yield* withGate(
      Ref.modify(state, (current): readonly [RequestLease[], State] => [
        [...current.active],
        current.closing ? current : { ...current, closing: true },
      ]),
    );
    yield* Scope.close(scope, Exit.void);
    yield* closeWhere(() => true);
    const drained = yield* drainLeasesEffect(active);
    if (drained) return;
    const error = new Error("MCP requests did not settle during shutdown");
    options.fatal?.(error);
    return yield* Effect.fail(error);
  });

  return {
    fetch: (request) => Effect.runPromise(routeEffect(request)),

    closeClientEffect: (clientId) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const [entries, active] = yield* withGate(
            Ref.modify(
              state,
              (current): readonly [readonly [SessionEntry[], RequestLease[]], State] => {
                const entries = [...current.entries]
                  .filter(([entry]) => entry.clientId === clientId)
                  .map(([entry]) => entry);
                const active = [...current.active].filter((lease) => lease.clientId === clientId);
                if (entries.length === 0) return [[entries, active], current];
                const selected = new Set(entries);
                const sessionSlotsByClient = new Map(current.sessionSlotsByClient);
                sessionSlotsByClient.delete(clientId);
                return [
                  [entries, active],
                  {
                    ...current,
                    entries: new Map(
                      [...current.entries].filter(([entry]) => !selected.has(entry)),
                    ),
                    sessions: new Map(
                      [...current.sessions].filter(([, entry]) => !selected.has(entry)),
                    ),
                    sessionSlotsByClient,
                    sessionSlots: current.sessionSlots - entries.length,
                  },
                ];
              },
            ),
          );
          yield* closeEntriesEffect(entries, true);
          if (yield* drainLeasesEffect(active)) return;
          const error = new Error("MCP requests did not settle during Client shutdown");
          options.fatal?.(error);
          return yield* Effect.fail(error);
        }),
      ),

    closeEffect,
  };

  function drainLeasesEffect(leases: ReadonlyArray<RequestLease>) {
    return Effect.all(
      leases.map((lease) => Deferred.await(lease.settled)),
      {
        concurrency: "unbounded",
      },
    ).pipe(
      Effect.as(true),
      Effect.timeoutOrElse({
        duration: Duration.millis(options.shutdownTimeoutMs ?? 6_000),
        orElse: () => Effect.succeed(false),
      }),
    );
  }
}

function abortEntryRequests(entry: SessionEntry): Effect.Effect<void> {
  return Effect.sync(() => {
    for (const controller of entry.requests.values())
      controller.abort(new DOMException("MCP session closed", "AbortError"));
  });
}

function handleSessionRequest(
  entry: SessionEntry,
  request: Request,
): Effect.Effect<Response, unknown> {
  return Effect.gen(function* () {
    const message = yield* Effect.tryPromise(() => request.clone().json()).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    );
    const cancelledId = mcpCancellationId(message);
    if (cancelledId) {
      entry.requests
        .get(cancelledId)
        ?.abort(new DOMException("MCP request cancelled", "AbortError"));
    }
    const requestId = mcpCallId(message);
    if (!requestId)
      return yield* Effect.tryPromise({
        try: () => entry.server.handle(request),
        catch: (error) => error,
      });
    const controller = new AbortController();
    entry.requests.set(requestId, controller);
    const controlled = new Request(request, {
      signal: AbortSignal.any([request.signal, controller.signal]),
    });
    return yield* Effect.tryPromise({
      try: () => entry.server.handle(controlled),
      catch: (error) => error,
    }).pipe(Effect.ensuring(Effect.sync(() => entry.requests.delete(requestId))));
  });
}

function mcpCallId(message: unknown): string | undefined {
  if (
    !message ||
    typeof message !== "object" ||
    !("method" in message) ||
    message.method !== "tools/call" ||
    !("id" in message) ||
    (typeof message.id !== "string" && typeof message.id !== "number")
  )
    return;
  return `${typeof message.id}:${message.id}`;
}

function mcpCancellationId(message: unknown): string | undefined {
  if (
    !message ||
    typeof message !== "object" ||
    !("method" in message) ||
    message.method !== "notifications/cancelled" ||
    !("params" in message) ||
    !message.params ||
    typeof message.params !== "object" ||
    !("requestId" in message.params) ||
    (typeof message.params.requestId !== "string" && typeof message.params.requestId !== "number")
  )
    return;
  return `${typeof message.params.requestId}:${message.params.requestId}`;
}

function boundedRequestEffect(
  request: Request,
  maximum: number,
  timeoutMs: number,
): Effect.Effect<Request | Response, unknown> {
  return Effect.gen(function* () {
    if (
      request.headers.get("content-encoding") &&
      request.headers.get("content-encoding") !== "identity"
    )
      return jsonRpcError(415, -32_600, "Encoded request bodies are not supported");
    const declared = request.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum))
      return jsonRpcError(
        Number(declared) > maximum ? 413 : 400,
        -32_600,
        "MCP request body is invalid or too large",
      );
    if (!request.body) return request;
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    const deadline = Date.now() + timeoutMs;
    return yield* Effect.gen(function* () {
      for (;;) {
        yield* Effect.try({
          try: () => request.signal.throwIfAborted(),
          catch: (error) => error,
        });
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          yield* Effect.tryPromise({
            try: () => reader.cancel(),
            catch: (error) => error,
          });
          return jsonRpcError(408, -32_000, "MCP request body timed out");
        }
        const result = yield* Effect.tryPromise({
          try: () => reader.read(),
          catch: (error) => error,
        }).pipe(
          Effect.map((value) => ({ kind: "read" as const, value })),
          Effect.timeoutOrElse({
            duration: Duration.millis(remaining),
            orElse: () => Effect.succeed({ kind: "timeout" as const }),
          }),
        );
        if (result.kind === "timeout") {
          yield* Effect.tryPromise({
            try: () => reader.cancel(),
            catch: (error) => error,
          });
          return jsonRpcError(408, -32_000, "MCP request body timed out");
        }
        const { done, value } = result.value;
        if (done) break;
        size += value.byteLength;
        if (size > maximum) {
          yield* Effect.tryPromise({
            try: () => reader.cancel(),
            catch: (error) => error,
          });
          return jsonRpcError(413, -32_600, "MCP request body is too large");
        }
        chunks.push(value);
      }
      return new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: Buffer.concat(chunks),
        signal: request.signal,
      });
    }).pipe(Effect.ensuring(Effect.sync(() => reader.releaseLock())));
  });
}

function createGatewayServer(
  app: QujingEffectApi,
  client: ClientIdentity,
  allowedOrigins: readonly string[],
): EffectMcpSession {
  const listWorkspaces = Tool.make("list_workspaces", {
    description: "List this colleague's manually registered Workspaces and their public summaries.",
    success: LineWorkspaces,
    failure: McpToolFailure,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.OpenWorld, false);
  const ask = Tool.make("ask", {
    description:
      "Ask this colleague a question in one exact Workspace. Later calls automatically continue the same Client and Workspace history.",
    parameters: Schema.Struct({
      workspace: NonEmptyString,
      question: Schema.String,
    }),
    success: LineAskResult,
    failure: McpToolFailure,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Idempotent, false)
    .annotate(Tool.Destructive, true)
    .annotate(Tool.OpenWorld, true);
  const toolkit = Toolkit.make(listWorkspaces, ask);
  const handlers = toolkit.toLayer({
    list_workspaces: () =>
      app.listWorkspacesEffect(client).pipe(Effect.mapError(gatewayToolFailure)),
    ask: ({ workspace, question }) =>
      withAbortSignal((signal) =>
        app
          .askEffect({ client, workspace, question }, signal)
          .pipe(Effect.mapError(gatewayToolFailure)),
      ),
  });
  const registrations = Layer.effectDiscard(McpServer.registerToolkit(toolkit)).pipe(
    Layer.provide(handlers),
  );
  return createEffectMcpSession("qujing", registrations, allowedOrigins);
}

function gatewayToolFailure(error: unknown): McpToolFailure {
  return new McpToolFailure({
    message:
      error instanceof QujingError
        ? `${error.code}: ${error.message}`
        : error instanceof DOMException && error.name === "AbortError"
          ? "RUNTIME_FAILED: Request cancelled"
          : "RUNTIME_FAILED: Runtime failed",
  });
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
