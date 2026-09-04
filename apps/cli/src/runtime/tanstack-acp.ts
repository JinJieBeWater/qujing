import { randomUUID } from "node:crypto";
import { join, parse } from "node:path";
import { chat, type ModelMessage, type StreamChunk } from "@tanstack/ai";
import { InMemoryLockStore, withLocks } from "@tanstack/ai/locks";
import { acpCompatible } from "@tanstack/ai-acp";
import { withPersistence } from "@tanstack/ai-persistence";
import { defineSandbox, defineWorkspace, withSandbox } from "@tanstack/ai-sandbox";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import { Deferred, Effect, Exit, Scope } from "effect";
import type { WorkspaceConfig } from "../config";
import type { TanStackAcpRuntime } from "../schemas";
import { QUJING_PROMPT } from "./prompt";
import type { RuntimeSession } from "./sessions";
import type { RuntimeAgentSession } from "./session";
import {
  createTanStackInstanceStore,
  createTanStackPersistence,
  JsonStore,
} from "./tanstack-persistence";
import { ensurePrivateDirectoryEffect } from "../private-files";

type TanStackPersistence = ReturnType<typeof createTanStackPersistence>;
type TanStackInstanceStore = ReturnType<typeof createTanStackInstanceStore>;

export interface TanStackAcpRuntimeFactoryOptions {
  stateRoot: string;
  persistence?: TanStackPersistence;
  instances?: TanStackInstanceStore;
  acpSessions?: TanStackAcpSessionStore;
  locks?: InMemoryLockStore;
}

export function createTanStackAcpSessionFactory(options: TanStackAcpRuntimeFactoryOptions) {
  const persistence = options.persistence ?? createTanStackPersistence(options);
  const instances = options.instances ?? createTanStackInstanceStore(options);
  const acpSessions = options.acpSessions ?? createTanStackAcpSessionStore(options);
  const locks = options.locks ?? new InMemoryLockStore();
  return (workspace: WorkspaceConfig, session: RuntimeSession, runtime: TanStackAcpRuntime) =>
    startManagedTanStackAcpSessionEffect({
      cwd: workspace.root,
      stateRoot: options.stateRoot,
      sessionId: session.id,
      runtime,
      persistence,
      instances,
      acpSessions,
      locks,
    });
}

export interface TanStackAcpSessionOptions {
  cwd: string;
  stateRoot: string;
  sessionId: string;
  runtime: TanStackAcpRuntime;
  persistence: TanStackPersistence;
  instances: TanStackInstanceStore;
  acpSessions?: TanStackAcpSessionStore;
  locks: InMemoryLockStore;
}

export function createTanStackAcpSessionStore(options: { stateRoot: string }) {
  return new JsonStore<StoredTanStackAcpSessionState>(
    join(options.stateRoot, "tanstack", "acp-sessions"),
    parseStoredTanStackAcpSessionState,
  );
}

type TanStackAcpSessionStore = ReturnType<typeof createTanStackAcpSessionStore>;

export function startManagedTanStackAcpSessionEffect(options: TanStackAcpSessionOptions) {
  return Effect.gen(function* () {
    const scope = yield* Scope.make();
    return new TanStackAcpSession(options, scope);
  });
}

class TanStackAcpSession implements RuntimeAgentSession {
  readonly self = this;

  private lastAssistantText: string | undefined;
  private currentAbort: AbortController | undefined;
  private currentPrompt: Deferred.Deferred<void, Error> | undefined;
  private disposed = false;

  constructor(
    private readonly options: TanStackAcpSessionOptions,
    private readonly scope: Scope.Closeable,
  ) {}

  getLastAssistantText(): string | undefined {
    return this.lastAssistantText;
  }

  isAlive(): boolean {
    return !this.disposed;
  }

  promptEffect(question: string): Effect.Effect<void, Error> {
    return Effect.gen(this, function* () {
      if (this.disposed) return yield* Effect.fail(new Error("TanStack ACP Runtime is stopped"));
      if (this.currentPrompt)
        return yield* Effect.fail(new Error("Runtime Session already has an active turn"));
      const controller = new AbortController();
      const prompt = yield* Deferred.make<void, Error>();
      this.currentAbort = controller;
      this.currentPrompt = prompt;
      this.lastAssistantText = undefined;
      yield* Effect.forkIn(
        this.runChatEffect(question, controller).pipe(
          Effect.exit,
          Effect.tap((exit) => Deferred.done(prompt, exit)),
          Effect.ensuring(
            Effect.sync(() => {
              if (this.currentAbort === controller) this.currentAbort = undefined;
              if (this.currentPrompt === prompt) this.currentPrompt = undefined;
            }),
          ),
        ),
        this.scope,
      );
      return yield* Deferred.await(prompt);
    });
  }

  clearQueueEffect(): Effect.Effect<void, Error> {
    return Effect.void;
  }

  abortEffect(): Effect.Effect<void, Error> {
    return Effect.sync(() => {
      this.currentAbort?.abort(new DOMException("Aborted", "AbortError"));
    });
  }

  waitForIdleEffect(): Effect.Effect<void, Error> {
    return Effect.suspend(() =>
      this.currentPrompt
        ? Deferred.await(this.currentPrompt).pipe(
            Effect.catch((error) => (isAbortError(error) ? Effect.void : Effect.fail(error))),
          )
        : Effect.void,
    );
  }

  disposeEffect(): Effect.Effect<void> {
    return Effect.sync(() => {
      this.disposed = true;
      this.currentAbort?.abort(new DOMException("Runtime stopped", "AbortError"));
    }).pipe(Effect.andThen(Scope.close(this.scope, Exit.void)));
  }

  private runChatEffect(
    question: string,
    abortController: AbortController,
  ): Effect.Effect<void, Error> {
    const runtime = this.options.runtime;
    const projectionRoot = join(
      this.options.stateRoot,
      "tanstack",
      "projection",
      encodeURIComponent(this.options.sessionId),
    );
    const acpSessions = this.options.acpSessions ?? createTanStackAcpSessionStore(this.options);
    return Effect.gen(this, function* () {
      yield* ensurePrivateDirectoryEffect(projectionRoot);
      const sessionState = yield* acpSessions.getEffect(this.options.sessionId);
      const adapter = acpCompatible({
        name: runtime.name,
        command: ({ model, harnessCwd }) =>
          renderCommand(runtime.command, { model, cwd: harnessCwd }),
        cwd: this.options.cwd,
        authMode: runtime.authMode ?? "host",
        ...(runtime.authMethodId === undefined ? {} : { authMethodId: runtime.authMethodId }),
        permissionMode: runtime.permissionMode ?? "bypassPermissions",
        permissions: "headless",
        refusalMessage: `${runtime.name} refused the request.`,
      });
      const sandbox = defineSandbox({
        id: `qujing-${runtime.name}`,
        provider: localProcessSandbox({
          dir: parse(this.options.cwd).root,
          removeOnDestroy: false,
        }),
        workspace: defineWorkspace({
          source: { type: "none" },
          root: projectionRoot,
        }),
        lifecycle: { reuse: "thread", keepAlive: "10m", destroyOnComplete: false },
        fileEvents: false,
      });
      const stored = yield* promise(() =>
        this.options.persistence.stores.messages.loadThread(this.options.sessionId),
      );
      const messages: Array<ModelMessage> = [...stored, { role: "user", content: question }];
      const stream = chat({
        adapter: adapter(runtime.model),
        messages,
        threadId: this.options.sessionId,
        runId: randomUUID(),
        ...(sessionState?.acpSessionId
          ? { modelOptions: { sessionId: sessionState.acpSessionId } }
          : {}),
        systemPrompts: [{ content: QUJING_PROMPT }],
        abortController,
        middleware: [
          withPersistence(this.options.persistence),
          withLocks(this.options.locks),
          withSandbox(sandbox, { instances: this.options.instances }),
        ],
      });
      const { text, acpSessionId } = yield* promise(() =>
        collectTanStackStream(stream, `${runtime.name}.session-id`),
      );
      if (acpSessionId) yield* acpSessions.setEffect(this.options.sessionId, { acpSessionId });
      this.lastAssistantText = text || undefined;
    }).pipe(Effect.mapError(toError));
  }
}

export function renderCommand(template: string, values: { model: string; cwd: string }): string {
  return template
    .replaceAll("{model}", shellQuote(values.model))
    .replaceAll("{cwd}", shellQuote(values.cwd));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function collectTanStackStream(
  stream: AsyncIterable<StreamChunk>,
  sessionEventName: string,
): Promise<{ text: string; acpSessionId?: string }> {
  let text = "";
  let acpSessionId: string | undefined;
  for await (const chunk of stream) {
    if (chunk.type === "RUN_ERROR") throw new Error(chunk.message || "TanStack ACP Runtime failed");
    if (chunk.type === "TEXT_MESSAGE_CONTENT" && chunk.delta) text += chunk.delta;
    if (chunk.type === "CUSTOM" && chunk.name === sessionEventName) {
      const value = chunk.value as { sessionId?: unknown } | string | undefined;
      if (typeof value === "string") acpSessionId = value;
      else if (value && typeof value === "object" && typeof value.sessionId === "string") {
        acpSessionId = value.sessionId;
      }
    }
  }
  return acpSessionId ? { text, acpSessionId } : { text };
}

interface StoredTanStackAcpSessionState {
  acpSessionId: string;
}

function parseStoredTanStackAcpSessionState(input: unknown): StoredTanStackAcpSessionState {
  if (
    input &&
    typeof input === "object" &&
    typeof (input as { acpSessionId?: unknown }).acpSessionId === "string"
  ) {
    return { acpSessionId: (input as { acpSessionId: string }).acpSessionId };
  }
  throw new Error("Invalid TanStack ACP session state");
}

function isAbortError(error: Error): boolean {
  return error.name === "AbortError";
}

function promise<A>(try_: () => Promise<A>): Effect.Effect<A, Error> {
  return Effect.tryPromise({
    try: try_,
    catch: toError,
  });
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
