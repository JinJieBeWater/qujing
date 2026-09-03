import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Ref,
  Schema,
  Scope,
} from "effect";
import packageJson from "../package.json";
import type { LineConfig } from "./client-config";
import { QujingError, type ErrorCode } from "./errors";
import {
  ErrorCodePayload,
  LineAskResult as LineAskResultSchema,
  LineWorkspaces as LineWorkspacesSchema,
  type LineAskResult,
  type LineWorkspaces,
} from "./schemas";
import {
  startConnectorEffect,
  type ConnectorOptions,
  type TransportProcess,
} from "./transport/process";

const BOOTSTRAP_TIMEOUT = Duration.seconds(40);
const UPSTREAM_ASK_TIMEOUT_MS = 130_000;
const CLOSE_TIMEOUT = Duration.seconds(6);
const parseWorkspaces = Schema.decodeUnknownSync(LineWorkspacesSchema);
const parseAsk = Schema.decodeUnknownSync(LineAskResultSchema);
const parseErrorCode = Schema.decodeUnknownOption(ErrorCodePayload);
const safeCodes = new Set<string>([
  "WORKSPACE_NOT_FOUND",
  "WORKSPACE_UNAVAILABLE",
  "INVALID_QUESTION",
  "RUNTIME_UNAVAILABLE",
  "RUNTIME_TIMEOUT",
  "RUNTIME_FAILED",
  "BUSY",
]);

export type { LineAskResult, LineWorkspaces };
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
  startConnectorEffect?: (
    options: ConnectorOptions,
    signal?: AbortSignal,
  ) => Effect.Effect<TransportProcess, unknown>;
  createUpstream?: (
    url: URL,
    bearer: string,
  ) => { client: UpstreamClient; transport: UpstreamTransport };
}
interface Session {
  connector: TransportProcess;
  client: UpstreamClient;
  transport: UpstreamTransport;
  scope: Scope.Closeable;
}
interface PendingSession {
  deferred: Deferred.Deferred<Session, unknown>;
  controller: AbortController;
  fiber?: Fiber.Fiber<unknown, unknown>;
  waiters: number;
}
interface State {
  session?: Session;
  pending?: PendingSession;
  closed: boolean;
}

/** Effect owns session lifecycle. */
export class LineRuntime {
  private readonly state: Ref.Ref<State>;
  private readonly scope = Scope.makeUnsafe("sequential");
  private readonly start: (
    options: ConnectorOptions,
    signal?: AbortSignal,
  ) => Effect.Effect<TransportProcess, unknown>;
  private readonly createUpstream: (
    url: URL,
    bearer: string,
  ) => { client: UpstreamClient; transport: UpstreamTransport };

  constructor(private readonly options: LineRuntimeOptions) {
    this.state = Effect.runSync(Ref.make<State>({ closed: false }));
    this.start =
      options.startConnectorEffect ??
      ((connector, signal) => startConnectorEffect(connector, undefined, signal));
    this.createUpstream =
      options.createUpstream ??
      ((url, bearer) => {
        const transport = new StreamableHTTPClientTransport(url, {
          requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
        });
        return {
          client: new Client({
            name: "qujing-client",
            version: packageJson.version,
          }) as unknown as UpstreamClient,
          transport,
        };
      });
  }

  listWorkspacesEffect(signal?: AbortSignal) {
    return Effect.gen({ self: this }, function* () {
      const session = yield* this.getSessionEffect(signal);
      return yield* this.callEffect(
        session,
        { name: "list_workspaces", arguments: {} },
        signal,
        40_000,
        (result) => this.verifiedWorkspaces(result),
      );
    });
  }

  askEffect(workspace: string, question: string, signal?: AbortSignal) {
    return Effect.gen({ self: this }, function* () {
      const session = yield* this.getSessionEffect(signal);
      return yield* this.callEffect(
        session,
        { name: "ask", arguments: { workspace, question } },
        signal,
        UPSTREAM_ASK_TIMEOUT_MS,
        (result) => this.result(result, parseAsk),
      );
    });
  }

  closeEffect() {
    return Effect.gen({ self: this }, function* () {
      const [session, pending] = yield* Ref.modify(this.state, (state) => [
        [state.session, state.pending] as const,
        { closed: true },
      ]);
      pending?.controller.abort();
      if (pending?.fiber) yield* Fiber.interrupt(pending.fiber);
      yield* Effect.all(
        [session ? this.closeScope(session.scope) : Effect.void, this.closeScope(this.scope)],
        { concurrency: "unbounded" },
      );
    });
  }

  private getSessionEffect(signal?: AbortSignal) {
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen({ self: this }, function* () {
        signal?.throwIfAborted();
        const candidate: PendingSession = {
          deferred: yield* Deferred.make<Session, unknown>(),
          controller: new AbortController(),
          waiters: 0,
        };
        const [session, pending] = yield* Ref.modify(
          this.state,
          (state): readonly [readonly [Session | undefined, PendingSession | undefined], State] => {
            if (state.closed) return [[undefined, undefined] as const, state];
            if (state.session) return [[state.session, undefined] as const, state];
            if (state.pending) {
              state.pending.waiters++;
              return [[undefined, state.pending] as const, state];
            }
            candidate.waiters++;
            return [[undefined, candidate] as const, { ...state, pending: candidate }];
          },
        );
        if (pending === candidate) {
          const created = pending;
          created.fiber = yield* this.createSessionEffect(created.controller.signal).pipe(
            Effect.interruptible,
            Effect.matchEffect({
              onFailure: (error) =>
                Ref.update(this.state, (current) => {
                  if (current.pending !== created) return current;
                  const { pending: _pending, ...withoutPending } = current;
                  return withoutPending;
                }).pipe(Effect.andThen(Deferred.fail(created.deferred, error))),
              onSuccess: (session) =>
                Ref.modify(this.state, (current) => {
                  const keep =
                    !current.closed && current.pending === created && created.waiters > 0;
                  const { pending: _pending, ...withoutPending } = current;
                  return [keep, keep ? { ...withoutPending, session } : withoutPending] as const;
                }).pipe(
                  Effect.flatMap((keep) =>
                    keep
                      ? Deferred.succeed(created.deferred, session)
                      : this.closeScope(session.scope).pipe(
                          Effect.andThen(
                            Deferred.fail(
                              created.deferred,
                              new DOMException("Aborted", "AbortError"),
                            ),
                          ),
                        ),
                  ),
                ),
            }),
            Effect.onExit((exit) =>
              Exit.isFailure(exit)
                ? Ref.update(this.state, (current) => {
                    if (current.pending !== created) return current;
                    const { pending: _pending, ...withoutPending } = current;
                    return withoutPending;
                  }).pipe(
                    Effect.andThen(
                      Deferred.fail(created.deferred, new DOMException("Aborted", "AbortError")),
                    ),
                  )
                : Effect.void,
            ),
            Effect.forkIn(this.scope, { uninterruptible: false }),
          );
        }
        if (session) return session;
        if (!pending)
          return yield* Effect.fail(new QujingError("LINE_UNAVAILABLE", "Line unavailable"));
        const active = pending;
        return yield* restore(this.waitForSessionEffect(active, signal)).pipe(
          Effect.ensuring(
            Ref.update(this.state, (current) => {
              active.waiters--;
              if (active.waiters === 0 && current.pending === active && !current.session)
                active.controller.abort();
              return current;
            }),
          ),
        );
      }),
    );
  }

  private waitForSessionEffect(pending: PendingSession, signal?: AbortSignal) {
    return signal
      ? Effect.raceFirst(Deferred.await(pending.deferred), abortEffect(signal))
      : Deferred.await(pending.deferred);
  }

  private createSessionEffect(signal: AbortSignal) {
    return Effect.gen({ self: this }, function* () {
      const scope = yield* Scope.make("sequential");
      return yield* Effect.onExit(
        Effect.provide(
          Effect.gen({ self: this }, function* () {
            const connector = yield* Effect.acquireRelease(
              this.timeout(
                this.start(
                  {
                    serverAddress: this.options.line.serverAddress,
                    remotePort: this.options.line.remotePort,
                    keyPath: this.options.line.keyPath,
                    localHost: "127.0.0.1",
                    localPort: 0,
                  },
                  signal,
                ),
              ),
              (connector) => connector.closeEffect().pipe(Effect.catchEager(() => Effect.void)),
              { interruptible: true },
            );
            if (!connector.ready.localAddress)
              return yield* Effect.fail(new Error("Connector did not provide local address"));
            const upstream = this.createUpstream(
              new URL(`http://${connector.ready.localAddress}/mcp`),
              this.options.line.remoteBearer,
            );
            yield* Effect.acquireRelease(
              this.timeout(
                this.promise(() =>
                  upstream.client.connect(upstream.transport, { signal, timeout: 40_000 }),
                ),
              ),
              () =>
                this.closePromise(async () => {
                  await upstream.transport.terminateSession?.();
                  await upstream.client.close();
                }),
              { interruptible: true },
            );
            const result = yield* this.timeout(
              this.promise(() =>
                upstream.client.callTool({ name: "list_workspaces", arguments: {} }, undefined, {
                  signal,
                  timeout: 40_000,
                }),
              ),
            );
            yield* Effect.try({
              try: () => this.verifiedWorkspaces(result),
              catch: (error) => error,
            });
            yield* Effect.try({ try: () => signal.throwIfAborted(), catch: (error) => error });
            return { connector, client: upstream.client, transport: upstream.transport, scope };
          }),
          Context.make(Scope.Scope, scope),
        ),
        (exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void),
      );
    });
  }

  private callEffect<T>(
    session: Session,
    params: { name: string; arguments: Record<string, unknown> },
    signal: AbortSignal | undefined,
    timeout: number,
    parse: (result: Record<string, unknown>) => T,
  ): Effect.Effect<T, unknown> {
    return Effect.acquireUseRelease(
      Effect.sync(() => ({
        controller: new AbortController(),
        promise: undefined as Promise<Record<string, unknown>> | undefined,
      })),
      (request) =>
        Effect.sync(() => {
          request.promise = session.client.callTool(
            params,
            undefined,
            requestOptions(mergeSignals(signal, request.controller.signal), timeout),
          );
          return request.promise;
        }).pipe(Effect.flatMap((promise) => this.promise(() => promise))),
      (request) =>
        Effect.sync(() => request.controller.abort()).pipe(
          Effect.andThen(
            request.promise
              ? this.promise(() => request.promise!).pipe(
                  Effect.ignore,
                  Effect.timeoutOrElse({
                    duration: CLOSE_TIMEOUT,
                    orElse: () => this.dropEffect(session),
                  }),
                )
              : Effect.void,
          ),
        ),
    ).pipe(
      Effect.flatMap((result) => Effect.try({ try: () => parse(result), catch: (error) => error })),
      Effect.catchEager((error): Effect.Effect<never, unknown> =>
        isAbort(error) || error instanceof QujingError
          ? Effect.fail(error)
          : this.dropEffect(session).pipe(Effect.andThen(Effect.fail(this.safeFailure(error)))),
      ),
    );
  }
  private dropEffect(session: Session) {
    return Ref.modify(this.state, (state) => {
      const { session: _session, ...withoutSession } = state;
      return [
        state.session === session,
        state.session === session ? withoutSession : state,
      ] as const;
    }).pipe(Effect.flatMap((drop) => (drop ? this.closeScope(session.scope) : Effect.void)));
  }
  private closeScope(scope: Scope.Closeable) {
    return Scope.close(scope, Exit.void).pipe(Effect.timeout(CLOSE_TIMEOUT), Effect.asVoid);
  }
  private timeout<A>(effect: Effect.Effect<A, unknown>) {
    return effect.pipe(
      Effect.timeoutOrElse({
        duration: BOOTSTRAP_TIMEOUT,
        orElse: () => Effect.fail(new Error("Bootstrap timed out")),
      }),
    );
  }
  private promise<A>(try_: () => Promise<A>) {
    return Effect.tryPromise({ try: try_, catch: (error) => error });
  }
  private closePromise(try_: () => Promise<void>) {
    return this.promise(try_).pipe(Effect.catchEager(() => Effect.void));
  }
  private verifiedWorkspaces(result: Record<string, unknown>): LineWorkspaces {
    const workspaces = this.result(result, parseWorkspaces);
    if (workspaces.owner.id !== this.options.line.expectedOwnerId)
      throw new QujingError("OWNER_ID_MISMATCH", "Owner identity mismatch");
    return workspaces;
  }
  private result<T>(result: Record<string, unknown>, parse: (input: unknown) => T): T {
    if (result.isError) throw this.gatewayFailure(result);
    try {
      return parse(result.structuredContent);
    } catch (error) {
      throw new Error("Invalid upstream response", { cause: error });
    }
  }
  private gatewayFailure(result: Record<string, unknown>): QujingError {
    const structured = Option.getOrUndefined(parseErrorCode(result.structuredContent))?.code;
    const text = Array.isArray(result.content)
      ? result.content.find(
          (item): item is { type: "text"; text: string } =>
            !!item &&
            typeof item === "object" &&
            (item as { type?: unknown }).type === "text" &&
            typeof (item as { text?: unknown }).text === "string",
        )?.text
      : undefined;
    const code = structured ?? /^([A-Z_]+):/.exec(text ?? "")?.[1];
    return new QujingError(
      safeCodes.has(code ?? "") ? (code as ErrorCode) : "RUNTIME_FAILED",
      "Remote request failed",
    );
  }
  private safeFailure(error: unknown): QujingError {
    return error instanceof QujingError
      ? error
      : new QujingError("LINE_UNAVAILABLE", "Line unavailable");
  }
}

function requestOptions(signal: AbortSignal | undefined, timeout: number) {
  return signal ? { signal, timeout } : { timeout };
}
function mergeSignals(external: AbortSignal | undefined, internal: AbortSignal): AbortSignal {
  return external ? AbortSignal.any([external, internal]) : internal;
}
function isAbort(error: unknown): error is DOMException {
  return error instanceof DOMException && error.name === "AbortError";
}
function abortEffect(signal: AbortSignal) {
  return Effect.callback<never, unknown>((resume) => {
    const abort = () =>
      resume(Effect.fail(signal.reason ?? new DOMException("Aborted", "AbortError")));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    return Effect.sync(() => signal.removeEventListener("abort", abort));
  });
}
