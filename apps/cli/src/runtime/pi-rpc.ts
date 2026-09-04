import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Context, Deferred, Duration, Effect, Exit, Queue, Scope } from "effect";
import { QUJING_PROMPT } from "./prompt";
import type { RuntimeAgentSession } from "./session";

interface RpcResponse {
  type: "response";
  id?: string;
  success: boolean;
  data?: unknown;
}

type PendingRequest = Deferred.Deferred<RpcResponse, Error>;

const MAX_RPC_LINE_BYTES = 16 * 1024 * 1024;
const MAX_RPC_STDOUT_BYTES = 32 * 1024 * 1024;
const MAX_UI_RESPONSE_BYTES = 4 * 1024;

export type PiRpcSessionEffect = RuntimeAgentSession;

export interface PiRpcOptions {
  cwd: string;
  sessionId: string;
  binary?: string;
  startupTimeoutMs?: number;
}

/** Scoped Effect API. Scope owns Pi process and reader fiber. */
export const startPiRpcSessionEffect = (
  options: PiRpcOptions,
): Effect.Effect<PiRpcSessionEffect, Error, Scope.Scope> =>
  Effect.gen(function* () {
    const child = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          spawn(
            options.binary ?? "pi",
            [
              "--mode",
              "rpc",
              "--approve",
              "--append-system-prompt",
              QUJING_PROMPT,
              "--session-id",
              options.sessionId,
            ],
            { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] },
          ),
        catch: (error) => new Error("Could not start global Pi", { cause: error }),
      }),
      (child) => stopChildEffect(child),
    );
    const session = yield* GlobalPiRpcSession.make(child);
    yield* Effect.addFinalizer(() => session.disposeEffect());
    yield* session.readerEffect.pipe(Effect.forkScoped);
    yield* session.commandEffect("get_state").pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(options.startupTimeoutMs ?? 30_000),
        orElse: () => Effect.fail(new Error("Global Pi startup timed out")),
      }),
      Effect.flatMap((response) => {
        const state = response.data as { sessionId?: unknown } | undefined;
        return state?.sessionId === options.sessionId
          ? Effect.succeed(session)
          : Effect.fail(new Error("Pi opened wrong Runtime Session"));
      }),
    );
    return session;
  });

/** Owned session Effect. Returned facade keeps its child Scope alive until dispose. */
export const startManagedPiRpcSessionEffect = (options: PiRpcOptions) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    return yield* Effect.provide(
      startPiRpcSessionEffect(options),
      Context.make(Scope.Scope, scope),
    ).pipe(
      Effect.map((session) => new ManagedPiRpcSession(session, scope)),
      Effect.tapError(() => Scope.close(scope, Exit.void)),
    );
  });

class ManagedPiRpcSession implements PiRpcSessionEffect {
  constructor(
    private readonly session: PiRpcSessionEffect,
    private readonly scope: Scope.Closeable,
  ) {}
  promptEffect(question: string) {
    return this.session.promptEffect(question);
  }
  getLastAssistantText() {
    return this.session.getLastAssistantText();
  }
  isAlive() {
    return this.session.isAlive();
  }
  clearQueueEffect() {
    return this.session.clearQueueEffect();
  }
  abortEffect() {
    return this.session.abortEffect();
  }
  waitForIdleEffect() {
    return this.session.waitForIdleEffect();
  }
  disposeEffect() {
    return Scope.close(this.scope, Exit.void);
  }
}

class GlobalPiRpcSession implements PiRpcSessionEffect {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly stdoutQueue = Effect.runSync(Queue.unbounded<Effect.Effect<void, Error>>());
  private readonly stdoutFragments: Buffer[] = [];
  private stdoutPartialBytes = 0;
  private stdoutQueuedBytes = 0;
  private stdoutProcessingBytes = 0;
  private stdoutRejected = false;
  private stdoutFailure: Error | undefined;
  private currentTurn: Deferred.Deferred<void, Error> | undefined;
  private lastAssistantText: string | undefined;
  private failed = false;
  private stopped = false;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly failure: Deferred.Deferred<void, Error>,
  ) {}

  static make(child: ChildProcessWithoutNullStreams): Effect.Effect<GlobalPiRpcSession> {
    return Deferred.make<void, Error>().pipe(
      Effect.map((failure) => new GlobalPiRpcSession(child, failure)),
    );
  }

  readonly readerEffect = Effect.acquireUseRelease(
    Effect.sync(() => {
      const onData = (chunk: Buffer) => {
        if (this.stdoutRejected) return;
        if (
          this.stdoutPartialBytes +
            this.stdoutQueuedBytes +
            this.stdoutProcessingBytes +
            chunk.byteLength >
          MAX_RPC_STDOUT_BYTES
        ) {
          this.rejectStdout(new Error("Global Pi RPC stdout exceeded buffer limit"));
          return;
        }
        this.stdoutQueuedBytes += chunk.byteLength;
        Queue.offerUnsafe(
          this.stdoutQueue,
          Effect.sync(() => {
            this.stdoutQueuedBytes -= chunk.byteLength;
            this.stdoutProcessingBytes = chunk.byteLength;
          }).pipe(
            Effect.andThen(this.readEffect(chunk)),
            Effect.ensuring(
              Effect.sync(() => {
                this.stdoutProcessingBytes = 0;
              }),
            ),
          ),
        );
      };
      const onEnd = () => {
        Queue.offerUnsafe(
          this.stdoutQueue,
          Effect.suspend(() =>
            this.stdoutPartialBytes > 0
              ? Effect.fail(new Error("Pi RPC ended with partial JSONL"))
              : Effect.void,
          ),
        );
      };
      const onError = (error: Error) => {
        Queue.offerUnsafe(
          this.stdoutQueue,
          Effect.fail(new Error("Could not start global Pi", { cause: error })),
        );
      };
      const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
        if (!this.stopped)
          Queue.offerUnsafe(
            this.stdoutQueue,
            Effect.fail(new Error(`Global Pi exited (${code ?? signal ?? "unknown"})`)),
          );
      };
      this.child.stdout.on("data", onData);
      this.child.stdout.on("end", onEnd);
      this.child.stderr.resume();
      this.child.on("error", onError);
      this.child.on("close", onClose);
      return { onData, onEnd, onError, onClose };
    }),
    () =>
      Queue.take(this.stdoutQueue).pipe(
        Effect.flatMap((effect) => effect),
        Effect.forever,
        Effect.catchEager((error) => this.failAndStopEffect(error)),
      ),
    ({ onData, onEnd, onError, onClose }) =>
      Effect.sync(() => {
        this.child.stdout.off("data", onData);
        this.child.stdout.off("end", onEnd);
        this.child.off("error", onError);
        this.child.off("close", onClose);
      }),
  );

  getLastAssistantText(): string | undefined {
    return this.lastAssistantText;
  }
  isAlive(): boolean {
    return (
      !this.failed &&
      !this.stopped &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    );
  }

  promptEffect(question: string): Effect.Effect<void, Error> {
    return Effect.gen({ self: this }, function* () {
      if (this.currentTurn)
        return yield* Effect.fail(new Error("Pi Runtime Session already has an active turn"));
      const turn = yield* Deferred.make<void, Error>();
      this.currentTurn = turn;
      this.lastAssistantText = undefined;
      yield* this.commandEffect("prompt", { message: question })
        .pipe(Effect.andThen(Deferred.await(turn)))
        .pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              if (this.currentTurn === turn) this.currentTurn = undefined;
            }),
          ),
        );
    });
  }

  clearQueueEffect(): Effect.Effect<void, Error> {
    return this.commandEffect("clear_queue").pipe(Effect.asVoid);
  }
  abortEffect(): Effect.Effect<void, Error> {
    return this.commandEffect("abort").pipe(Effect.asVoid);
  }
  waitForIdleEffect(): Effect.Effect<void, Error> {
    return Effect.suspend(() =>
      this.currentTurn ? Deferred.await(this.currentTurn) : Effect.void,
    );
  }
  disposeEffect(): Effect.Effect<void> {
    return Effect.sync(() => {
      this.stopped = true;
      this.child.stdout.pause();
    }).pipe(
      Effect.andThen(stopChildEffect(this.child)),
      Effect.andThen(this.failEffect(new Error("Global Pi stopped"))),
    );
  }

  commandEffect(
    type: string,
    fields: Record<string, unknown> = {},
  ): Effect.Effect<RpcResponse, Error> {
    return Effect.gen({ self: this }, function* () {
      if (this.stopped) return yield* Effect.fail(new Error("Global Pi is stopped"));
      const id = randomUUID();
      const pending = yield* Deferred.make<RpcResponse, Error>();
      this.pending.set(id, pending);
      yield* this.writeEffect({ type, id, ...fields });
      const response = yield* Deferred.await(pending);
      if (!response.success) return yield* Effect.fail(new Error(`Pi RPC command failed: ${type}`));
      return response;
    });
  }

  private readEffect(chunk: Buffer): Effect.Effect<void, Error> {
    return Effect.gen({ self: this }, function* () {
      let offset = 0;
      let newline = chunk.indexOf(0x0a);
      while (newline !== -1) {
        const fragment = chunk.subarray(offset, newline);
        if (fragment.includes(0x0d))
          return yield* Effect.fail(new Error("Global Pi emitted non-LF JSONL"));
        const lineBytes = this.stdoutPartialBytes + fragment.byteLength;
        if (lineBytes > MAX_RPC_LINE_BYTES)
          return yield* Effect.fail(new Error("Global Pi RPC JSONL line exceeded byte limit"));
        const line =
          this.stdoutFragments.length === 0
            ? fragment
            : Buffer.concat([...this.stdoutFragments, fragment], lineBytes);
        this.stdoutFragments.length = 0;
        this.stdoutPartialBytes = 0;
        if (line.length > 0) yield* this.handleLineEffect(line.toString("utf8"));
        offset = newline + 1;
        newline = chunk.indexOf(0x0a, offset);
      }
      const remainder = chunk.subarray(offset);
      if (remainder.includes(0x0d))
        return yield* Effect.fail(new Error("Global Pi emitted non-LF JSONL"));
      if (this.stdoutPartialBytes + remainder.byteLength > MAX_RPC_LINE_BYTES)
        return yield* Effect.fail(new Error("Global Pi RPC JSONL line exceeded byte limit"));
      if (remainder.byteLength > 0) {
        this.stdoutFragments.push(offset === 0 ? remainder : Buffer.from(remainder));
        this.stdoutPartialBytes += remainder.byteLength;
      }
    });
  }

  private handleLineEffect(line: string): Effect.Effect<void, Error> {
    return Effect.gen({ self: this }, function* () {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch (error) {
        return yield* Effect.fail(new Error("Global Pi emitted invalid JSONL", { cause: error }));
      }
      if (message.type === "response" && typeof message.id === "string") {
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id);
          yield* Deferred.succeed(pending, message as unknown as RpcResponse);
        }
        return;
      }
      if (message.type === "message_end") this.captureAssistant(message.message);
      if (message.type === "agent_settled") {
        const turn = this.currentTurn;
        this.currentTurn = undefined;
        if (turn) yield* Deferred.succeed(turn, undefined);
        return;
      }
      if (message.type === "extension_ui_request") yield* this.answerUiRequestEffect(message);
    });
  }

  private captureAssistant(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const message = value as { role?: unknown; content?: unknown };
    if (message.role !== "assistant" || !Array.isArray(message.content)) return;
    const text = message.content
      .filter((part): part is { type: "text"; text: string } =>
        Boolean(
          part &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
        ),
      )
      .map((part) => part.text)
      .join("");
    this.lastAssistantText = text || undefined;
  }

  private answerUiRequestEffect(request: Record<string, unknown>): Effect.Effect<void, Error> {
    if (typeof request.id !== "string") return Effect.void;
    if (request.method === "confirm")
      return this.writeEffect({ type: "extension_ui_response", id: request.id, confirmed: true });
    if (request.method === "select" && Array.isArray(request.options)) {
      const value = request.options.find((option): option is string => typeof option === "string");
      return this.writeEffect(
        value === undefined
          ? { type: "extension_ui_response", id: request.id, cancelled: true }
          : { type: "extension_ui_response", id: request.id, value },
      );
    }
    if (request.method === "input" || request.method === "editor")
      return this.writeEffect({
        type: "extension_ui_response",
        id: request.id,
        value:
          request.method === "editor" && typeof request.prefill === "string"
            ? request.prefill.slice(0, MAX_UI_RESPONSE_BYTES)
            : "",
      });
    return Effect.void;
  }

  private writeEffect(message: Record<string, unknown>): Effect.Effect<void, Error> {
    if (this.stopped || !this.child.stdin.writable)
      return Effect.fail(this.stdoutFailure ?? new Error("Global Pi is stopped"));
    return Effect.callback<void, Error>((resume) => {
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) =>
        resume(error ? Effect.fail(this.stdoutFailure ?? error) : Effect.void),
      );
    });
  }

  private failEffect(error: Error): Effect.Effect<void> {
    return Effect.sync(() => this.failUnsafe(error));
  }

  private failAndStopEffect(error: Error): Effect.Effect<void> {
    const failure = this.stdoutFailure ?? error;
    return Effect.sync(() => {
      this.stdoutRejected = true;
      this.stopped = true;
      this.child.stdout.pause();
    }).pipe(Effect.andThen(this.failEffect(failure)), Effect.andThen(stopChildEffect(this.child)));
  }

  private rejectStdout(error: Error): void {
    if (this.stdoutRejected) return;
    this.stdoutRejected = true;
    this.stdoutFailure = error;
    this.stopped = true;
    this.child.stdout.pause();
    this.failUnsafe(error);
    this.child.kill("SIGTERM");
    Queue.offerUnsafe(this.stdoutQueue, Effect.fail(error));
  }

  private failUnsafe(error: Error): void {
    this.failed = true;
    for (const pending of this.pending.values()) Deferred.doneUnsafe(pending, Effect.fail(error));
    this.pending.clear();
    if (this.currentTurn) Deferred.doneUnsafe(this.currentTurn, Effect.fail(error));
    this.currentTurn = undefined;
    Deferred.doneUnsafe(this.failure, Effect.fail(error));
  }
}

function stopChildEffect(child: ChildProcessWithoutNullStreams): Effect.Effect<void> {
  return Effect.suspend(() => {
    if (child.exitCode !== null || child.signalCode !== null) return Effect.void;
    return Effect.sync(() => child.kill("SIGTERM")).pipe(
      Effect.andThen(
        waitForExitEffect(child).pipe(
          Effect.timeoutOrElse({
            duration: Duration.seconds(1),
            orElse: () =>
              Effect.sync(() => {
                child.kill("SIGKILL");
              }),
          }),
        ),
      ),
    );
  });
}

function waitForExitEffect(child: ChildProcessWithoutNullStreams): Effect.Effect<void> {
  return Effect.callback<void>((resume, signal) => {
    const onExit = () => resume(Effect.void);
    child.once("exit", onExit);
    return Effect.sync(() => {
      child.off("exit", onExit);
      signal.removeEventListener("abort", onAbort);
    });
    function onAbort() {}
  });
}
