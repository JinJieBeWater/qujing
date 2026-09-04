import { randomUUID } from "node:crypto";
import { Deferred, Effect, Exit, Ref, Semaphore } from "effect";
import type { Config, ConfigStore } from "../config";
import { QujingError } from "../errors";
import { Question, decode, type ClientIdentity } from "../schemas";
import { purgeRemovedRuntimeSessionsEffect } from "./cleanup";
import { RuntimePool } from "./runtime-pool";
import { RuntimeSessionStore } from "./sessions";

const decodeQuestion = decode(Question);

interface RuntimeLease {
  id: string;
  clientId: string;
  workspaceId: string;
  controller: AbortController;
  settled: Deferred.Deferred<void>;
}

interface CoordinatorState {
  desired: Config;
  leases: ReadonlyMap<string, RuntimeLease>;
  blockedClients: ReadonlySet<string>;
  blockedWorkspaces: ReadonlySet<string>;
  blockAll: boolean;
  stopped: boolean;
}

export interface RuntimeCoordinatorOptions {
  config: ConfigStore;
  sessions: RuntimeSessionStore;
  runtime: RuntimePool;
  desired: Config;
}

export interface CoordinatedAnswerInput {
  client: ClientIdentity;
  workspaceId: string;
  question: string;
  signal: AbortSignal;
}

/** Coordinates short admissions and reconciliations; Pi work runs outside gate. */
export class RuntimeCoordinator {
  private constructor(
    private readonly options: RuntimeCoordinatorOptions,
    private readonly gate: Semaphore.Semaphore,
    private readonly reconciliation: Semaphore.Semaphore,
    private readonly state: Ref.Ref<CoordinatorState>,
  ) {}

  static createEffect(options: RuntimeCoordinatorOptions) {
    return Effect.gen(function* () {
      yield* purgeRemovedRuntimeSessionsEffect(
        {
          clientIds: options.desired.clients.map((client) => client.id),
          workspaceIds: options.desired.workspaces.map((workspace) => workspace.id),
        },
        options.sessions,
      );
      return new RuntimeCoordinator(
        options,
        yield* Semaphore.make(1),
        yield* Semaphore.make(1),
        yield* Ref.make<CoordinatorState>({
          desired: options.desired,
          leases: new Map(),
          blockedClients: new Set(),
          blockedWorkspaces: new Set(),
          blockAll: false,
          stopped: false,
        }),
      );
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit) ? options.runtime.disposeEffect().pipe(Effect.orDie) : Effect.void,
      ),
    );
  }

  answerEffect(input: CoordinatedAnswerInput) {
    return Effect.gen({ self: this }, function* () {
      const admitted = yield* this.withGateEffect(
        this.options.config.withLockEffect(
          Effect.gen({ self: this }, function* () {
            const state = yield* Ref.get(this.state);
            if (state.stopped) throw new QujingError("RUNTIME_UNAVAILABLE", "Runtime is stopped");
            if (
              state.blockAll ||
              state.blockedClients.has(input.client.id) ||
              state.blockedWorkspaces.has(input.workspaceId)
            ) {
              throw new QujingError("BUSY", "Runtime scope is being reconciled");
            }
            input.signal.throwIfAborted();
            const effective = yield* this.options.config.readEffectiveEffect();
            input.signal.throwIfAborted();
            if (
              !effective.clients.some(
                (client) =>
                  client.id === input.client.id &&
                  client.bearerHash === input.client.credentialVersion,
              )
            ) {
              throw new QujingError("UNAUTHORIZED", "Client is not authorized");
            }
            yield* Effect.try({
              try: () => decodeQuestion(input.question),
              catch: () =>
                new QujingError(
                  "INVALID_QUESTION",
                  input.question.trim().length === 0
                    ? "Question must not be empty"
                    : "Question must not exceed 20,000 characters",
                ),
            });
            const workspace = effective.workspaces.find((entry) => entry.id === input.workspaceId);
            if (!workspace)
              throw new QujingError(
                "WORKSPACE_NOT_FOUND",
                `Workspace not found: ${input.workspaceId}`,
              );
            if (!(yield* this.options.config.isWorkspaceAvailableEffect(workspace.root))) {
              throw new QujingError(
                "WORKSPACE_UNAVAILABLE",
                `Workspace unavailable: ${input.workspaceId}`,
              );
            }
            input.signal.throwIfAborted();
            const session = yield* this.options.sessions.getOrCreateEffect(
              input.client.id,
              workspace.id,
            );
            const lease = yield* createLeaseEffect(input.client.id, workspace.id);
            yield* Ref.update(this.state, (current) => ({
              ...current,
              leases: new Map(current.leases).set(lease.id, lease),
            }));
            return { workspace, session, lease };
          }),
        ),
      );
      const signal = AbortSignal.any([input.signal, admitted.lease.controller.signal]);
      return yield* Effect.ensuring(
        Effect.gen({ self: this }, function* () {
          const result = yield* this.options.runtime.answerEffect({
            workspace: admitted.workspace,
            session: admitted.session,
            question: input.question,
            signal,
          });
          signal.throwIfAborted();
          yield* this.options.sessions.touchEffect(admitted.session);
          signal.throwIfAborted();
          return result.answer;
        }),
        Deferred.succeed(admitted.lease.settled, undefined).pipe(
          Effect.andThen(
            this.withGateEffect(
              Ref.update(this.state, (current) => {
                const leases = new Map(current.leases);
                leases.delete(admitted.lease.id);
                return { ...current, leases };
              }),
            ),
          ),
        ),
      );
    });
  }

  reconcileEffect(next: Config) {
    return this.reconciliation.withPermit(this.reconcileNowEffect(next));
  }

  closeEffect() {
    return Effect.gen({ self: this }, function* () {
      const leases = yield* this.withGateEffect(
        Ref.modify(this.state, (state) => {
          const active = [...state.leases.values()];
          for (const lease of active)
            lease.controller.abort(new DOMException("Runtime stopped", "AbortError"));
          return [active, { ...state, stopped: true, blockAll: true }] as const;
        }),
      );
      yield* Effect.all(
        leases.map((lease) => Deferred.await(lease.settled)),
        {
          concurrency: "unbounded",
        },
      );
      yield* this.options.runtime.disposeEffect();
    });
  }

  private reconcileNowEffect(next: Config) {
    return Effect.gen({ self: this }, function* () {
      const desired = (yield* Ref.get(this.state)).desired;
      const runtimeChanged = runtimeConfigChanged(desired, next);
      const removedOrChangedClients = [
        ...removedIds(desired.clients, next.clients),
        ...changedClientIds(desired, next),
      ];
      const removedOrChangedWorkspaces = [
        ...removedIds(desired.workspaces, next.workspaces),
        ...changedWorkspaceIds(desired, next),
      ];
      const affectedClients = new Set(
        runtimeChanged ? desired.clients.map((client) => client.id) : removedOrChangedClients,
      );
      const affectedWorkspaces = new Set(
        runtimeChanged
          ? desired.workspaces.map((workspace) => workspace.id)
          : removedOrChangedWorkspaces,
      );
      const leases = yield* this.withGateEffect(
        Ref.modify(this.state, (state) => {
          const active = [...state.leases.values()].filter(
            (lease) =>
              affectedClients.has(lease.clientId) || affectedWorkspaces.has(lease.workspaceId),
          );
          for (const lease of active)
            lease.controller.abort(new DOMException("Runtime scope retired", "AbortError"));
          return [
            active,
            {
              ...state,
              blockedClients: new Set([...state.blockedClients, ...affectedClients]),
              blockedWorkspaces: new Set([...state.blockedWorkspaces, ...affectedWorkspaces]),
            },
          ] as const;
        }),
      );
      yield* Effect.all(
        leases.map((lease) => Deferred.await(lease.settled)),
        {
          concurrency: "unbounded",
        },
      );
      yield* Effect.forEach(
        affectedClients,
        (clientId) => this.options.runtime.disposeClientEffect(clientId),
        { concurrency: 1 },
      );
      yield* Effect.forEach(
        affectedWorkspaces,
        (workspaceId) => this.options.runtime.disposeWorkspaceEffect(workspaceId),
        { concurrency: 1 },
      );
      yield* purgeRemovedRuntimeSessionsEffect(
        {
          clientIds: next.clients.map(({ id }) => id),
          workspaceIds: next.workspaces
            .filter(({ id }) => !removedOrChangedWorkspaces.includes(id))
            .map(({ id }) => id),
        },
        this.options.sessions,
      );
      yield* this.withGateEffect(
        Ref.update(this.state, (state) => ({
          ...state,
          desired: next,
          blockedClients: new Set(
            [...state.blockedClients].filter((id) => !affectedClients.has(id)),
          ),
          blockedWorkspaces: new Set(
            [...state.blockedWorkspaces].filter((id) => !affectedWorkspaces.has(id)),
          ),
        })),
      );
    });
  }

  private withGateEffect<A, E, R>(effect: Effect.Effect<A, E, R>) {
    return this.gate.withPermit(effect);
  }
}

function createLeaseEffect(clientId: string, workspaceId: string) {
  return Effect.gen(function* () {
    return {
      id: randomUUID(),
      clientId,
      workspaceId,
      controller: new AbortController(),
      settled: yield* Deferred.make<void>(),
    } satisfies RuntimeLease;
  });
}

function removedIds(
  previous: ReadonlyArray<{ id: string }>,
  next: ReadonlyArray<{ id: string }>,
): string[] {
  const active = new Set(next.map(({ id }) => id));
  return previous.filter(({ id }) => !active.has(id)).map(({ id }) => id);
}

function changedClientIds(previous: Config, next: Config): string[] {
  const current = new Map(
    next.clients.map((client) => [client.id, `${client.tailcatKey}\0${client.bearerHash}`]),
  );
  return previous.clients
    .filter(
      (client) =>
        current.has(client.id) &&
        current.get(client.id) !== `${client.tailcatKey}\0${client.bearerHash}`,
    )
    .map((client) => client.id);
}

function changedWorkspaceIds(previous: Config, next: Config): string[] {
  const current = new Map(next.workspaces.map((workspace) => [workspace.id, workspace.root]));
  return previous.workspaces
    .filter(
      (workspace) => current.has(workspace.id) && current.get(workspace.id) !== workspace.root,
    )
    .map((workspace) => workspace.id);
}

function runtimeConfigChanged(previous: Config, next: Config): boolean {
  return JSON.stringify(previous.runtime ?? null) !== JSON.stringify(next.runtime ?? null);
}
