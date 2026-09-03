import { createHash } from "node:crypto";
import { Deferred, Effect, Ref, Semaphore } from "effect";
import type { ClientConfig, ClientConfigStore, LineConfig } from "./client-config";
import { QujingError } from "./errors";
import { LineRuntime, type LineAskResult, type LineWorkspaces } from "./line-runtime";
import type { ClientAskResult, ClientLine } from "./schemas";
import { startConnectorEffect } from "./transport/process";

export interface LineRuntimeClient {
  listWorkspacesEffect(signal?: AbortSignal): Effect.Effect<LineWorkspaces, unknown>;
  askEffect(
    workspace: string,
    question: string,
    signal?: AbortSignal,
  ): Effect.Effect<LineAskResult, unknown>;
  closeEffect(): Effect.Effect<void, unknown>;
}

export interface ClientApplicationOptions {
  config: Pick<ClientConfigStore, "readEffect">;
  createRuntime?: (line: LineConfig) => LineRuntimeClient;
}
interface RuntimeEntry {
  fingerprint: string;
  runtime: LineRuntimeClient;
}
interface OperationLease {
  controller: AbortController;
  signal: AbortSignal;
  settled: Deferred.Deferred<void>;
}
interface State {
  runtimes: Map<string, RuntimeEntry>;
  active: Map<string, Set<OperationLease>>;
  blocked: Map<string, string>;
  closed: boolean;
}

/** Effect owns coordination. */
export class ClientApplication {
  private readonly createRuntime: (line: LineConfig) => LineRuntimeClient;
  private readonly gate = Effect.runSync(Semaphore.make(1));
  private readonly state = Effect.runSync(
    Ref.make<State>({ runtimes: new Map(), active: new Map(), blocked: new Map(), closed: false }),
  );

  constructor(private readonly options: ClientApplicationOptions) {
    this.createRuntime =
      options.createRuntime ??
      ((line) =>
        new LineRuntime({
          line,
          startConnectorEffect: (options, signal) =>
            startConnectorEffect(options, undefined, signal),
        }));
  }

  reconcileEffect() {
    return this.withGateEffect(
      Effect.gen({ self: this }, function* () {
        yield* this.assertOpenEffect();
        const config = yield* this.readConfigEffect();
        yield* this.reconcileLockedEffect(config);
        return config;
      }),
    );
  }

  listLinesEffect(signal?: AbortSignal) {
    return Effect.gen({ self: this }, function* () {
      yield* throwIfAbortedEffect(signal);
      const lines = yield* this.withGateEffect(
        Effect.gen({ self: this }, function* () {
          yield* this.assertOpenEffect();
          const config = yield* this.readConfigEffect();
          yield* this.reconcileLockedEffect(config);
          const state = yield* Ref.get(this.state);
          return yield* Effect.forEach(config.lines, (line) => {
            if (state.blocked.has(line.id)) return Effect.succeed({ line });
            return this.runtimeAndLeaseLockedEffect(line, signal).pipe(
              Effect.map(({ runtime, lease }) => ({ line, runtime, lease })),
            );
          });
        }),
      );
      return yield* Effect.all(
        lines.map((entry) => {
          const { line } = entry;
          if (!("runtime" in entry))
            return Effect.succeed<ClientLine>({ id: line.id, available: false, workspaces: [] });
          const { runtime, lease } = entry as {
            line: LineConfig;
            runtime: LineRuntimeClient;
            lease: OperationLease;
          };
          return this.listWorkspacesEffect(runtime, lease.signal).pipe(
            Effect.map((listed): ClientLine => ({
              id: line.id,
              available: true,
              owner: listed.owner,
              workspaces: listed.workspaces,
            })),
            Effect.catchEager((error) =>
              isAbort(error)
                ? Effect.fail(error)
                : Effect.succeed<ClientLine>({ id: line.id, available: false, workspaces: [] }),
            ),
            Effect.ensuring(this.finishLeaseEffect(line.id, lease)),
          );
        }),
        { concurrency: "unbounded" },
      );
    });
  }

  askEffect(input: { line: string; workspace: string; question: string }, signal?: AbortSignal) {
    return Effect.gen({ self: this }, function* () {
      yield* throwIfAbortedEffect(signal);
      const admitted = yield* this.withGateEffect(
        Effect.gen({ self: this }, function* () {
          yield* this.assertOpenEffect();
          const config = yield* this.readConfigEffect();
          yield* this.reconcileLockedEffect(config);
          const line = config.lines.find((entry) => entry.id === input.line);
          if (!line) return yield* Effect.fail(new QujingError("LINE_NOT_FOUND", "Line not found"));
          if ((yield* Ref.get(this.state)).blocked.has(line.id))
            return yield* Effect.fail(lineUnavailable());
          return yield* this.runtimeAndLeaseLockedEffect(line, signal).pipe(
            Effect.map(({ runtime, lease }) => ({ line, runtime, lease })),
          );
        }),
      );
      return yield* this.askRuntimeEffect(
        admitted.runtime,
        input.workspace,
        input.question,
        admitted.lease.signal,
      ).pipe(
        Effect.map((result): ClientAskResult => ({
          line: admitted.line.id,
          workspace: result.workspace,
          answer: result.answer,
        })),
        Effect.ensuring(this.finishLeaseEffect(admitted.line.id, admitted.lease)),
      );
    });
  }

  retireLineEffect(id: string, expectedFingerprint: string) {
    return this.withGateEffect(
      Effect.gen({ self: this }, function* () {
        yield* this.assertOpenEffect();
        const config = yield* this.readConfigEffect();
        const line = config.lines.find((entry) => entry.id === id);
        if (!line || lineFingerprint(line) !== expectedFingerprint)
          return yield* Effect.fail(new Error("Line changed before retirement completed"));
        yield* this.blockAndRetireLockedEffect(id, expectedFingerprint);
      }),
    );
  }

  resumeLineEffect(id: string, expectedFingerprint: string) {
    return this.withGateEffect(
      Ref.update(this.state, (state) =>
        state.blocked.get(id) === expectedFingerprint
          ? { ...state, blocked: without(state.blocked, id) }
          : state,
      ),
    );
  }

  closeEffect() {
    return this.withGateEffect(
      Effect.gen({ self: this }, function* () {
        const state = yield* Ref.get(this.state);
        if (state.closed) return;
        yield* Ref.update(this.state, (current) => ({ ...current, closed: true }));
        const ids = new Set([...state.runtimes.keys(), ...state.active.keys()]);
        yield* Effect.all(
          [...ids].map((id) => this.retireRuntimeLockedEffect(id)),
          { concurrency: "unbounded" },
        );
        yield* Ref.update(this.state, (current) => ({ ...current, blocked: new Map() }));
      }),
    );
  }

  private reconcileLockedEffect(config: ClientConfig) {
    return Effect.gen({ self: this }, function* () {
      const current = new Map(config.lines.map((line) => [line.id, lineFingerprint(line)]));
      yield* Ref.update(this.state, (state) => ({
        ...state,
        blocked: new Map(
          [...state.blocked].filter(([id, fingerprint]) => current.get(id) === fingerprint),
        ),
      }));
      const stale = [...(yield* Ref.get(this.state)).runtimes]
        .filter(([id, entry]) => current.get(id) !== entry.fingerprint)
        .map(([id]) => id);
      yield* Effect.all(
        stale.map((id) => this.retireRuntimeLockedEffect(id)),
        { concurrency: "unbounded" },
      ).pipe(
        Effect.catchEager((error) =>
          Effect.fail(new AggregateError([error], "Line retirement failed")),
        ),
      );
    });
  }

  private runtimeAndLeaseLockedEffect(line: LineConfig, signal?: AbortSignal) {
    return Effect.gen({ self: this }, function* () {
      const fingerprint = lineFingerprint(line);
      const state = yield* Ref.get(this.state);
      const runtime =
        state.runtimes.get(line.id)?.fingerprint === fingerprint
          ? state.runtimes.get(line.id)!.runtime
          : this.createRuntime(line);
      if (!state.runtimes.has(line.id) || state.runtimes.get(line.id)?.fingerprint !== fingerprint)
        yield* Ref.update(this.state, (current) => ({
          ...current,
          runtimes: new Map(current.runtimes).set(line.id, { fingerprint, runtime }),
        }));
      const controller = new AbortController();
      const lease = {
        controller,
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
        settled: yield* Deferred.make<void>(),
      };
      const leases = new Set((yield* Ref.get(this.state)).active.get(line.id) ?? []).add(lease);
      yield* Ref.update(this.state, (current) => ({
        ...current,
        active: new Map(current.active).set(line.id, leases),
      }));
      return { runtime, lease };
    });
  }

  private blockAndRetireLockedEffect(id: string, fingerprint: string) {
    return Ref.update(this.state, (state) => ({
      ...state,
      blocked: new Map(state.blocked).set(id, fingerprint),
    })).pipe(Effect.andThen(this.retireRuntimeLockedEffect(id)));
  }
  private retireRuntimeLockedEffect(id: string) {
    return Effect.gen({ self: this }, function* () {
      const [entry, leases] = yield* Ref.modify(this.state, (state) => {
        const active = [...(state.active.get(id) ?? [])];
        for (const lease of active) lease.controller.abort(lineUnavailable());
        return [
          [state.runtimes.get(id), active] as const,
          { ...state, runtimes: without(state.runtimes, id) },
        ] as const;
      });
      yield* Effect.all(
        leases.map((lease) => Deferred.await(lease.settled)),
        { concurrency: "unbounded" },
      ).pipe(
        Effect.andThen(entry ? this.closeRuntimeEffect(entry.runtime) : Effect.void),
        Effect.catchEager((error) =>
          Effect.fail(new AggregateError([error], "Line retirement failed")),
        ),
      );
    });
  }
  private finishLeaseEffect(id: string, lease: OperationLease) {
    return Deferred.succeed(lease.settled, undefined).pipe(
      Effect.andThen(
        Ref.update(this.state, (state) => {
          const active = new Map(state.active);
          const leases = new Set(active.get(id));
          leases.delete(lease);
          if (leases.size) active.set(id, leases);
          else active.delete(id);
          return { ...state, active };
        }),
      ),
    );
  }
  private readConfigEffect() {
    return this.options.config.readEffect();
  }
  private listWorkspacesEffect(runtime: LineRuntimeClient, signal: AbortSignal) {
    return runtime.listWorkspacesEffect(signal);
  }
  private askRuntimeEffect(
    runtime: LineRuntimeClient,
    workspace: string,
    question: string,
    signal: AbortSignal,
  ) {
    return runtime.askEffect(workspace, question, signal);
  }
  private closeRuntimeEffect(runtime: LineRuntimeClient) {
    return runtime.closeEffect();
  }
  private assertOpenEffect() {
    return Ref.get(this.state).pipe(
      Effect.flatMap((state) =>
        state.closed
          ? Effect.fail(new QujingError("LINE_UNAVAILABLE", "Client is stopped"))
          : Effect.void,
      ),
    );
  }
  private withGateEffect<A, E, R>(effect: Effect.Effect<A, E, R>) {
    return this.gate.withPermit(effect);
  }
}

export function lineFingerprint(line: LineConfig): string {
  return createHash("sha256").update(JSON.stringify(line)).digest("hex");
}
function without<K, V>(map: Map<K, V>, key: K) {
  const next = new Map(map);
  next.delete(key);
  return next;
}
function lineUnavailable(): QujingError {
  return new QujingError("LINE_UNAVAILABLE", "Line unavailable");
}
function isAbort(error: unknown): error is DOMException {
  return error instanceof DOMException && error.name === "AbortError";
}
function throwIfAbortedEffect(signal?: AbortSignal) {
  return Effect.try({ try: () => signal?.throwIfAborted(), catch: (error) => error });
}
