import { createHash } from "node:crypto";
import { Deferred, Effect, Ref, Semaphore } from "effect";
import type { AgentConfig, AgentConfigStore, PeerConfig } from "./agent-config";
import { QujingError } from "./errors";
import { PeerRuntime, type PeerAskResult, type PeerWorkspaces } from "./peer-runtime";
import type { AgentAskResult, AgentPeer } from "./schemas";
import { startConnectorEffect } from "./transport/process";

export interface PeerRuntimeAgent {
  listWorkspacesEffect(signal?: AbortSignal): Effect.Effect<PeerWorkspaces, unknown>;
  askEffect(
    workspace: string,
    question: string,
    signal?: AbortSignal,
  ): Effect.Effect<PeerAskResult, unknown>;
  closeEffect(): Effect.Effect<void, unknown>;
}

export interface AgentApplicationOptions {
  config: Pick<AgentConfigStore, "readEffect">;
  createRuntime?: (peer: PeerConfig) => PeerRuntimeAgent;
}
interface RuntimeEntry {
  fingerprint: string;
  runtime: PeerRuntimeAgent;
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
export class AgentApplication {
  private readonly createRuntime: (peer: PeerConfig) => PeerRuntimeAgent;
  private readonly gate = Effect.runSync(Semaphore.make(1));
  private readonly state = Effect.runSync(
    Ref.make<State>({ runtimes: new Map(), active: new Map(), blocked: new Map(), closed: false }),
  );

  constructor(private readonly options: AgentApplicationOptions) {
    this.createRuntime =
      options.createRuntime ??
      ((peer) =>
        new PeerRuntime({
          peer,
          startConnectorEffect: (options, signal) =>
            startConnectorEffect(options, undefined, signal),
        }));
  }

  reconcileEffect() {
    return this.withGateEffect(
      Effect.gen({ self: this }, function* () {
        yield* this.assertOpenEffect();
        const config = yield* this.options.config.readEffect();
        yield* this.reconcileLockedEffect(config);
        return config;
      }),
    );
  }

  listPeersEffect(signal?: AbortSignal) {
    return Effect.gen({ self: this }, function* () {
      yield* throwIfAbortedEffect(signal);
      const peers = yield* this.withGateEffect(
        Effect.gen({ self: this }, function* () {
          yield* this.assertOpenEffect();
          const config = yield* this.options.config.readEffect();
          yield* this.reconcileLockedEffect(config);
          const state = yield* Ref.get(this.state);
          return yield* Effect.forEach(config.peers, (peer) => {
            if (state.blocked.has(peer.id)) return Effect.succeed({ peer });
            return this.runtimeAndLeaseLockedEffect(peer, signal).pipe(
              Effect.map(({ runtime, lease }) => ({ peer, runtime, lease })),
            );
          });
        }),
      );
      return yield* Effect.all(
        peers.map((entry) => {
          const { peer } = entry;
          if (!("runtime" in entry))
            return Effect.succeed<AgentPeer>({ id: peer.id, available: false, workspaces: [] });
          const { runtime, lease } = entry as {
            peer: PeerConfig;
            runtime: PeerRuntimeAgent;
            lease: OperationLease;
          };
          return runtime.listWorkspacesEffect(lease.signal).pipe(
            Effect.map((listed): AgentPeer => ({
              id: peer.id,
              available: true,
              node: listed.node,
              workspaces: listed.workspaces,
            })),
            Effect.catchEager((error) =>
              isAbort(error)
                ? Effect.fail(error)
                : Effect.succeed<AgentPeer>({ id: peer.id, available: false, workspaces: [] }),
            ),
            Effect.ensuring(this.finishLeaseEffect(peer.id, lease)),
          );
        }),
        { concurrency: "unbounded" },
      );
    });
  }

  askEffect(input: { peer: string; workspace: string; question: string }, signal?: AbortSignal) {
    return Effect.gen({ self: this }, function* () {
      yield* throwIfAbortedEffect(signal);
      const admitted = yield* this.withGateEffect(
        Effect.gen({ self: this }, function* () {
          yield* this.assertOpenEffect();
          const config = yield* this.options.config.readEffect();
          yield* this.reconcileLockedEffect(config);
          const peer = config.peers.find((entry) => entry.id === input.peer);
          if (!peer) return yield* Effect.fail(new QujingError("PEER_NOT_FOUND", "Peer not found"));
          if ((yield* Ref.get(this.state)).blocked.has(peer.id))
            return yield* Effect.fail(peerUnavailable());
          return yield* this.runtimeAndLeaseLockedEffect(peer, signal).pipe(
            Effect.map(({ runtime, lease }) => ({ peer, runtime, lease })),
          );
        }),
      );
      return yield* admitted.runtime
        .askEffect(input.workspace, input.question, admitted.lease.signal)
        .pipe(
          Effect.map((result): AgentAskResult => ({
            peer: admitted.peer.id,
            workspace: result.workspace,
            answer: result.answer,
          })),
          Effect.ensuring(this.finishLeaseEffect(admitted.peer.id, admitted.lease)),
        );
    });
  }

  retirePeerEffect(id: string, expectedFingerprint: string) {
    return this.withGateEffect(
      Effect.gen({ self: this }, function* () {
        yield* this.assertOpenEffect();
        const config = yield* this.options.config.readEffect();
        const peer = config.peers.find((entry) => entry.id === id);
        if (!peer || peerFingerprint(peer) !== expectedFingerprint)
          return yield* Effect.fail(new Error("Peer changed before retirement completed"));
        yield* this.blockAndRetireLockedEffect(id, expectedFingerprint);
      }),
    );
  }

  resumePeerEffect(id: string, expectedFingerprint: string) {
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

  private reconcileLockedEffect(config: AgentConfig) {
    return Effect.gen({ self: this }, function* () {
      const current = new Map(config.peers.map((peer) => [peer.id, peerFingerprint(peer)]));
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
          Effect.fail(new AggregateError([error], "Peer retirement failed")),
        ),
      );
    });
  }

  private runtimeAndLeaseLockedEffect(peer: PeerConfig, signal?: AbortSignal) {
    return Effect.gen({ self: this }, function* () {
      const fingerprint = peerFingerprint(peer);
      const state = yield* Ref.get(this.state);
      const runtime =
        state.runtimes.get(peer.id)?.fingerprint === fingerprint
          ? state.runtimes.get(peer.id)!.runtime
          : this.createRuntime(peer);
      if (!state.runtimes.has(peer.id) || state.runtimes.get(peer.id)?.fingerprint !== fingerprint)
        yield* Ref.update(this.state, (current) => ({
          ...current,
          runtimes: new Map(current.runtimes).set(peer.id, { fingerprint, runtime }),
        }));
      const controller = new AbortController();
      const lease = {
        controller,
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
        settled: yield* Deferred.make<void>(),
      };
      const leases = new Set((yield* Ref.get(this.state)).active.get(peer.id) ?? []).add(lease);
      yield* Ref.update(this.state, (current) => ({
        ...current,
        active: new Map(current.active).set(peer.id, leases),
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
        for (const lease of active) lease.controller.abort(peerUnavailable());
        return [
          [state.runtimes.get(id), active] as const,
          { ...state, runtimes: without(state.runtimes, id) },
        ] as const;
      });
      yield* Effect.all(
        leases.map((lease) => Deferred.await(lease.settled)),
        { concurrency: "unbounded" },
      ).pipe(
        Effect.andThen(entry ? entry.runtime.closeEffect() : Effect.void),
        Effect.catchEager((error) =>
          Effect.fail(new AggregateError([error], "Peer retirement failed")),
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
  private assertOpenEffect() {
    return Ref.get(this.state).pipe(
      Effect.flatMap((state) =>
        state.closed
          ? Effect.fail(new QujingError("PEER_UNAVAILABLE", "Agent is stopped"))
          : Effect.void,
      ),
    );
  }
  private withGateEffect<A, E, R>(effect: Effect.Effect<A, E, R>) {
    return this.gate.withPermit(effect);
  }
}

export function peerFingerprint(peer: PeerConfig): string {
  return createHash("sha256").update(JSON.stringify(peer)).digest("hex");
}
function without<K, V>(map: Map<K, V>, key: K) {
  const next = new Map(map);
  next.delete(key);
  return next;
}
function peerUnavailable(): QujingError {
  return new QujingError("PEER_UNAVAILABLE", "Peer unavailable");
}
function isAbort(error: unknown): error is DOMException {
  return error instanceof DOMException && error.name === "AbortError";
}
function throwIfAbortedEffect(signal?: AbortSignal) {
  return Effect.try({ try: () => signal?.throwIfAborted(), catch: (error) => error });
}
