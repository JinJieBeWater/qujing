import { Duration, Effect, Exit, Fiber, Scope, Semaphore } from "effect";
import type { WorkspaceConfig } from "../config";
import { ABORT_SETTLE_TIMEOUT_MS, ASK_TIMEOUT_MS } from "../constants";
import { QujingError } from "../errors";
import type { RuntimeSession } from "./sessions";
import type { RuntimeAgentSession } from "./session";

export interface RuntimePoolAnswerInput {
  workspace: WorkspaceConfig;
  session: RuntimeSession;
  question: string;
  signal: AbortSignal;
}

interface RuntimeEntry {
  session: RuntimeAgentSession;
  clientId: string;
  workspaceId: string;
  turnGate: Semaphore.Semaphore;
  busy: boolean;
  waiting: number;
  lastUsed: number;
}

interface RuntimeCreation {
  clientId: string;
  workspaceId: string;
  retired: boolean;
  fiber: Fiber.Fiber<RuntimeEntry, unknown>;
}

export interface RuntimePoolOptions {
  createSessionEffect(
    workspace: WorkspaceConfig,
    session: RuntimeSession,
  ): Effect.Effect<RuntimeAgentSession, unknown>;
  maxRuntimes?: number;
  queueCapacity?: number;
  idleTimeoutMs?: number;
  askTimeoutMs?: number;
  abortTimeoutMs?: number;
  creationRetireTimeoutMs?: number;
  createTimeoutSignal?: (timeoutMs: number) => AbortSignal;
  now?: () => number;
  fatal?: (error: Error) => void;
}

type EntryDecision =
  | { readonly kind: "entry"; readonly entry: RuntimeEntry }
  | { readonly kind: "creation"; readonly creation: RuntimeCreation };

type TurnDecision =
  | { readonly kind: "running" }
  | { readonly kind: "retry" }
  | { readonly kind: "dead" };

export class RuntimePool {
  readonly self = this;
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly creations = new Map<string, RuntimeCreation>();
  private readonly retirements = new Set<Fiber.Fiber<void, unknown>>();
  private readonly gate = Semaphore.makeUnsafe(1);
  private readonly scope = Scope.makeUnsafe("parallel");
  private readonly sweepFiber: Fiber.Fiber<void, never>;
  private occupied = 0;
  private disposed = false;

  constructor(private readonly options: RuntimePoolOptions) {
    process.umask(0o077);
    this.sweepFiber = Effect.runSync(
      Effect.forkIn(this.sweepLoopEffect(), this.scope, { startImmediately: true }),
    );
  }

  static createEffect(options: RuntimePoolOptions) {
    return Effect.sync(() => new RuntimePool(options));
  }

  answerEffect(input: RuntimePoolAnswerInput): Effect.Effect<{ answer: string }, unknown> {
    const timeoutSignal = (this.options.createTimeoutSignal ?? AbortSignal.timeout)(
      this.options.askTimeoutMs ?? ASK_TIMEOUT_MS,
    );
    const signal = AbortSignal.any([input.signal, timeoutSignal]);
    return Effect.raceFirst(this.runAnswerEffect(input), abortEffect(signal)).pipe(
      Effect.catch((error) => {
        if (timeoutSignal.aborted && !input.signal.aborted)
          return Effect.fail(new QujingError("RUNTIME_TIMEOUT", "Runtime timed out"));
        if (input.signal.aborted) return Effect.fail(input.signal.reason);
        return Effect.fail(error);
      }),
    );
  }

  private runAnswerEffect(
    input: RuntimePoolAnswerInput,
  ): Effect.Effect<{ answer: string }, unknown> {
    return Effect.gen(this, function* () {
      while (true) {
        const entry = yield* this.getEntryEffect(input.workspace, input.session);
        const reserved = yield* this.gate.withPermit(
          Effect.sync(() => {
            if (this.entries.get(input.session.id) !== entry) return false;
            if (entry.waiting >= (this.options.queueCapacity ?? 20))
              throw new QujingError("BUSY", "Runtime Session queue is full");
            entry.waiting++;
            return true;
          }),
        );
        if (!reserved) continue;

        let waiting = true;
        const decision = yield* entry.turnGate
          .withPermit(
            Effect.uninterruptibleMask((restore) =>
              Effect.gen(this, function* () {
                const turn = yield* this.gate.withPermit(
                  Effect.sync((): TurnDecision => {
                    entry.waiting--;
                    waiting = false;
                    if (this.entries.get(input.session.id) !== entry) return { kind: "retry" };
                    if (!entry.session.isAlive()) {
                      this.entries.delete(input.session.id);
                      return { kind: "dead" };
                    }
                    entry.busy = true;
                    return { kind: "running" };
                  }),
                );
                if (turn.kind === "retry") return turn;
                if (turn.kind === "dead") {
                  yield* restore(this.retireRemovedEntryEffect(entry, false));
                  return turn;
                }
                return yield* restore(this.runTurnEffect(entry, input.question)).pipe(
                  Effect.map((answer) => ({ kind: "running", answer }) as const),
                  Effect.ensuring(
                    this.gate.withPermit(
                      Effect.sync(() => {
                        entry.busy = false;
                        entry.lastUsed = this.now();
                      }),
                    ),
                  ),
                );
              }),
            ),
          )
          .pipe(
            Effect.ensuring(
              Effect.suspend(() => {
                if (!waiting) return Effect.void;
                waiting = false;
                return this.gate.withPermit(
                  Effect.sync(() => {
                    entry.waiting--;
                  }),
                );
              }),
            ),
          );
        if (decision.kind !== "running" || !("answer" in decision)) continue;
        return { answer: decision.answer };
      }
    });
  }

  private runTurnEffect(entry: RuntimeEntry, question: string): Effect.Effect<string, unknown> {
    return this.promptSessionEffect(entry.session, question).pipe(
      Effect.onInterrupt(() => this.abortSessionEffect(entry.session).pipe(Effect.orDie)),
      Effect.flatMap(() => {
        const answer = entry.session.getLastAssistantText();
        return answer
          ? Effect.succeed(answer)
          : Effect.fail(new QujingError("RUNTIME_FAILED", "Runtime returned no answer"));
      }),
      Effect.catch((error) =>
        Effect.gen(this, function* () {
          if (!entry.session.isAlive()) yield* this.evictEffect(entry);
          if (error instanceof QujingError) return yield* Effect.fail(error);
          return yield* Effect.fail(
            new QujingError("RUNTIME_FAILED", "Runtime failed", { cause: error }),
          );
        }),
      ),
    );
  }

  private abortSessionEffect(session: RuntimeAgentSession): Effect.Effect<void, unknown> {
    return this.clearQueueSessionEffect(session).pipe(
      Effect.andThen(this.abortRuntimeSessionEffect(session)),
      Effect.andThen(this.waitForIdleSessionEffect(session)),
      Effect.catch((cause) =>
        this.fatalFailureEffect(new Error("Runtime abort failed", { cause })),
      ),
      Effect.timeoutOrElse({
        duration: Duration.millis(this.options.abortTimeoutMs ?? ABORT_SETTLE_TIMEOUT_MS),
        orElse: () => this.fatalFailureEffect(new Error("Runtime did not settle after abort")),
      }),
    );
  }

  private getEntryEffect(
    workspace: WorkspaceConfig,
    session: RuntimeSession,
  ): Effect.Effect<RuntimeEntry, unknown> {
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(this, function* () {
        const decision = yield* this.gate.withPermit(
          Effect.gen(this, function* () {
            if (this.disposed)
              return yield* Effect.fail(
                new QujingError("RUNTIME_UNAVAILABLE", "Runtime is stopped"),
              );
            const existing = this.entries.get(session.id);
            if (existing) return { kind: "entry", entry: existing } satisfies EntryDecision;
            const active = this.creations.get(session.id);
            if (active) return { kind: "creation", creation: active } satisfies EntryDecision;

            let evicted: RuntimeEntry | undefined;
            if (this.occupied >= (this.options.maxRuntimes ?? 4)) {
              const idle = [...this.entries.entries()]
                .filter(([, entry]) => !entry.busy && entry.waiting === 0)
                .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
              if (!idle)
                return yield* Effect.fail(new QujingError("BUSY", "All Runtime slots are active"));
              this.entries.delete(idle[0]);
              evicted = idle[1];
            } else {
              this.occupied++;
            }

            const creation = {
              clientId: session.clientId,
              workspaceId: session.workspaceId,
              retired: false,
              fiber: undefined as unknown as Fiber.Fiber<RuntimeEntry, unknown>,
            };
            const fiber = yield* Effect.forkIn(
              Effect.suspend(() => this.createEntryEffect(workspace, session, creation, evicted)),
              this.scope,
              { startImmediately: false },
            );
            creation.fiber = fiber;
            this.creations.set(session.id, creation);
            return { kind: "creation", creation } satisfies EntryDecision;
          }),
        );
        return decision.kind === "entry"
          ? decision.entry
          : yield* restore(Fiber.join(decision.creation.fiber));
      }),
    );
  }

  private createEntryEffect(
    workspace: WorkspaceConfig,
    session: RuntimeSession,
    creation: RuntimeCreation,
    evicted?: RuntimeEntry,
  ): Effect.Effect<RuntimeEntry, unknown> {
    let managed: RuntimeAgentSession | undefined;
    let committed = false;
    return Effect.gen(this, function* () {
      if (evicted) yield* this.disposeSessionEffect(evicted.session);
      managed = yield* this.options.createSessionEffect(workspace, session);
      const started = managed;
      const entry: RuntimeEntry = {
        session: started,
        clientId: session.clientId,
        workspaceId: session.workspaceId,
        turnGate: Semaphore.makeUnsafe(1),
        busy: false,
        waiting: 0,
        lastUsed: this.now(),
      };
      const accepted = yield* this.gate.withPermit(
        Effect.sync(() => {
          if (this.creations.get(session.id) !== creation || creation.retired || this.disposed)
            return false;
          this.creations.delete(session.id);
          this.entries.set(session.id, entry);
          committed = true;
          return true;
        }),
      );
      if (!accepted) {
        const late = managed;
        managed = undefined;
        yield* this.disposeSessionEffect(late!).pipe(Effect.ignore);
        return yield* Effect.fail(
          new DOMException("Runtime Session creation retired", "AbortError"),
        );
      }
      managed = undefined;
      return entry;
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(this, function* () {
          if (managed) {
            const current = managed;
            managed = undefined;
            yield* this.disposeSessionEffect(current).pipe(Effect.ignore);
          }
          if (creation.retired || this.disposed) return yield* Effect.fail(error);
          return yield* Effect.fail(
            new QujingError("RUNTIME_UNAVAILABLE", "Could not start Runtime", {
              cause: error,
            }),
          );
        }),
      ),
      Effect.ensuring(
        this.gate.withPermit(
          Effect.sync(() => {
            if (this.creations.get(session.id) === creation) this.creations.delete(session.id);
            if (!committed) this.occupied--;
          }),
        ),
      ),
    );
  }

  private evictEffect(entry: RuntimeEntry): Effect.Effect<void, unknown> {
    return Effect.uninterruptibleMask(() =>
      Effect.gen(this, function* () {
        const removed = yield* this.gate.withPermit(
          Effect.sync(() => {
            for (const [id, candidate] of this.entries) {
              if (candidate !== entry) continue;
              this.entries.delete(id);
              return true;
            }
            return false;
          }),
        );
        if (removed) yield* this.retireRemovedEntryEffect(entry, false);
      }),
    );
  }

  private retireEntryEffect(
    id: string,
    entry: RuntimeEntry,
    abort: boolean,
  ): Effect.Effect<void, unknown> {
    return Effect.uninterruptibleMask(() =>
      Effect.gen(this, function* () {
        const removed = yield* this.gate.withPermit(
          Effect.sync(() => {
            if (this.entries.get(id) !== entry) return false;
            this.entries.delete(id);
            return true;
          }),
        );
        if (removed) yield* this.retireRemovedEntryEffect(entry, abort);
      }),
    );
  }

  private retireRemovedEntryEffect(
    entry: RuntimeEntry,
    abort: boolean,
  ): Effect.Effect<void, unknown> {
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(this, function* () {
        const retirement = (abort ? this.abortSessionEffect(entry.session) : Effect.void).pipe(
          Effect.andThen(this.disposeSessionEffect(entry.session)),
          Effect.ensuring(
            this.gate.withPermit(
              Effect.sync(() => {
                this.occupied--;
              }),
            ),
          ),
        );
        const fiber = yield* Effect.forkIn(retirement, this.scope, { startImmediately: true });
        yield* this.gate.withPermit(Effect.sync(() => this.retirements.add(fiber)));
        const exit = yield* restore(Fiber.await(fiber)).pipe(
          Effect.ensuring(
            Fiber.await(fiber).pipe(
              Effect.andThen(
                this.gate.withPermit(Effect.sync(() => this.retirements.delete(fiber))),
              ),
            ),
          ),
        );
        return yield* exit;
      }),
    );
  }

  disposeClientEffect(clientId: string): Effect.Effect<void, unknown> {
    return Effect.gen(this, function* () {
      yield* this.retireCreationsEffect((creation) => creation.clientId === clientId);
      const entries = yield* this.gate.withPermit(
        Effect.sync(() => [...this.entries].filter(([, entry]) => entry.clientId === clientId)),
      );
      yield* Effect.all(
        entries.map(([id, entry]) =>
          this.retireEntryEffect(id, entry, entry.busy || entry.waiting > 0),
        ),
        { concurrency: "unbounded" },
      );
    });
  }

  disposeWorkspaceEffect(workspaceId: string): Effect.Effect<void, unknown> {
    return Effect.gen(this, function* () {
      yield* this.retireCreationsEffect((creation) => creation.workspaceId === workspaceId);
      const entries = yield* this.gate.withPermit(
        Effect.sync(() =>
          [...this.entries].filter(([, entry]) => entry.workspaceId === workspaceId),
        ),
      );
      yield* Effect.all(
        entries.map(([id, entry]) =>
          this.retireEntryEffect(id, entry, entry.busy || entry.waiting > 0),
        ),
        { concurrency: "unbounded" },
      );
    });
  }

  private retireCreationsEffect(
    predicate: (creation: RuntimeCreation) => boolean,
  ): Effect.Effect<void, unknown> {
    return Effect.gen(this, function* () {
      const matching = yield* this.gate.withPermit(
        Effect.sync(() => {
          const active = [...this.creations.values()].filter(predicate);
          for (const creation of active) creation.retired = true;
          return active;
        }),
      );
      yield* this.waitForRetiredCreationsEffect(matching);
    });
  }

  private waitForRetiredCreationsEffect(
    creations: ReadonlyArray<RuntimeCreation>,
  ): Effect.Effect<void, unknown> {
    if (creations.length === 0) return Effect.void;
    return Fiber.awaitAll(creations.map((creation) => creation.fiber)).pipe(
      Effect.asVoid,
      Effect.timeoutOrElse({
        duration: Duration.millis(this.options.creationRetireTimeoutMs ?? ABORT_SETTLE_TIMEOUT_MS),
        orElse: () =>
          this.fatalFailureEffect(
            new Error("Runtime Session creation did not settle during retirement"),
          ),
      }),
    );
  }

  disposeEffect(): Effect.Effect<void, unknown> {
    return Effect.gen(this, function* () {
      const creations = yield* this.gate.withPermit(
        Effect.sync(() => {
          this.disposed = true;
          const active = [...this.creations.values()];
          for (const creation of active) creation.retired = true;
          return active;
        }),
      );
      yield* Fiber.interrupt(this.sweepFiber);
      yield* this.waitForRetiredCreationsEffect(creations);
      const entries = yield* this.gate.withPermit(Effect.sync(() => [...this.entries]));
      yield* Effect.all(
        entries.map(([id, entry]) =>
          this.retireEntryEffect(id, entry, entry.busy || entry.waiting > 0),
        ),
        { concurrency: "unbounded" },
      );
      const retirements = yield* this.gate.withPermit(Effect.sync(() => [...this.retirements]));
      yield* Fiber.awaitAll(retirements);
      yield* Scope.close(this.scope, Exit.void);
    });
  }

  private sweepLoopEffect(): Effect.Effect<never, never> {
    return Effect.forever(
      Effect.sleep(Duration.millis(Math.min(this.options.idleTimeoutMs ?? 600_000, 60_000))).pipe(
        Effect.andThen(this.sweepIdleEffect()),
        Effect.catch((error) =>
          Effect.sync(() => this.reportFatal(error)).pipe(Effect.andThen(Effect.never)),
        ),
      ),
    );
  }

  private sweepIdleEffect(): Effect.Effect<void, unknown> {
    return Effect.gen(this, function* () {
      const cutoff = this.now() - (this.options.idleTimeoutMs ?? 600_000);
      while (true) {
        const idle = yield* this.gate.withPermit(
          Effect.sync(() =>
            [...this.entries].find(
              ([, entry]) => !entry.busy && entry.waiting === 0 && entry.lastUsed <= cutoff,
            ),
          ),
        );
        if (!idle) return;
        yield* this.retireEntryEffect(idle[0], idle[1], false);
      }
    });
  }

  private promptSessionEffect(session: RuntimeAgentSession, question: string) {
    return session.promptEffect(question);
  }

  private clearQueueSessionEffect(session: RuntimeAgentSession) {
    return session.clearQueueEffect();
  }

  private abortRuntimeSessionEffect(session: RuntimeAgentSession) {
    return session.abortEffect();
  }

  private waitForIdleSessionEffect(session: RuntimeAgentSession) {
    return session.waitForIdleEffect();
  }

  private disposeSessionEffect(session: RuntimeAgentSession) {
    return session.disposeEffect();
  }

  private fatalFailureEffect(error: Error): Effect.Effect<never, Error> {
    return Effect.sync(() => this.reportFatal(error)).pipe(Effect.andThen(Effect.fail(error)));
  }

  private reportFatal(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (this.options.fatal) this.options.fatal(failure);
    else process.exit(1);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function abortEffect(signal: AbortSignal): Effect.Effect<never, unknown> {
  return Effect.callback((resume) => {
    const abort = () => resume(Effect.fail(signal.reason));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", abort));
  });
}
