import { randomUUID } from "node:crypto";
import type { Config, ConfigStore } from "../config";
import { ColleagueLineError } from "../errors";
import { RuntimeSessionStore } from "./sessions";
import {
  purgeClientRuntimeSessions,
  purgeRemovedRuntimeSessions,
  purgeWorkspaceRuntimeSessions,
} from "./cleanup";
import { PiRuntime } from "./pi-runtime";
import type { ClientIdentity } from "../types";

interface RuntimeLease {
  id: string;
  clientId: string;
  workspaceId: string;
  controller: AbortController;
  settled: Promise<void>;
  resolveSettled(): void;
}

export interface RuntimeCoordinatorOptions {
  config: ConfigStore;
  sessions: RuntimeSessionStore;
  runtime: PiRuntime;
  desired: Config;
}

export interface CoordinatedAnswerInput {
  client: ClientIdentity;
  workspaceId: string;
  question: string;
  signal: AbortSignal;
}

/**
 * Owns the short lifecycle gate shared by ask admission and desired-state
 * reconciliation. Pi work never runs while the gate is held.
 */
export class RuntimeCoordinator {
  private gateTail = Promise.resolve();
  private reconciliationTail = Promise.resolve();
  private readonly leases = new Map<string, RuntimeLease>();
  private readonly blockedClients = new Set<string>();
  private readonly blockedWorkspaces = new Set<string>();
  private blockAll = false;
  private stopped = false;

  private constructor(
    private readonly options: RuntimeCoordinatorOptions,
    private desired: Config,
  ) {}

  static async create(options: RuntimeCoordinatorOptions): Promise<RuntimeCoordinator> {
    await purgeRemovedRuntimeSessions(
      {
        clientIds: options.desired.clients.map((client) => client.id),
        workspaceIds: options.desired.workspaces.map((workspace) => workspace.id),
      },
      options.sessions,
    );
    return new RuntimeCoordinator(options, options.desired);
  }

  async answer(input: CoordinatedAnswerInput): Promise<string> {
    const admitted = await this.withGate(() =>
      this.options.config.withLock(async () => {
        if (this.stopped) throw new ColleagueLineError("RUNTIME_UNAVAILABLE", "Runtime is stopped");
        if (
          this.blockAll ||
          this.blockedClients.has(input.client.id) ||
          this.blockedWorkspaces.has(input.workspaceId)
        ) {
          throw new ColleagueLineError("BUSY", "Runtime scope is being reconciled");
        }
        input.signal.throwIfAborted();
        const effective = await this.options.config.readEffective();
        input.signal.throwIfAborted();
        if (
          !effective.clients.some(
            (client) =>
              client.id === input.client.id && client.bearerHash === input.client.credentialVersion,
          )
        ) {
          throw new ColleagueLineError("UNAUTHORIZED", "Client is not authorized");
        }
        const workspace = effective.workspaces.find((entry) => entry.id === input.workspaceId);
        if (!workspace)
          throw new ColleagueLineError(
            "WORKSPACE_NOT_FOUND",
            `Workspace not found: ${input.workspaceId}`,
          );
        if (!(await this.options.config.isWorkspaceAvailable(workspace.root))) {
          throw new ColleagueLineError(
            "WORKSPACE_UNAVAILABLE",
            `Workspace unavailable: ${input.workspaceId}`,
          );
        }
        input.signal.throwIfAborted();
        const session = await this.options.sessions.getOrCreate(input.client.id, workspace.id);
        const lease = createLease(input.client.id, workspace.id);
        this.leases.set(lease.id, lease);
        return { workspace, session, lease };
      }),
    );

    const signal = AbortSignal.any([input.signal, admitted.lease.controller.signal]);
    try {
      const result = await this.options.runtime.answer({
        workspace: admitted.workspace,
        session: admitted.session,
        question: input.question,
        signal,
      });
      signal.throwIfAborted();
      await this.options.sessions.touch(admitted.session);
      return result.answer;
    } finally {
      admitted.lease.resolveSettled();
      await this.withGate(async () => {
        this.leases.delete(admitted.lease.id);
      });
    }
  }

  reconcile(next: Config): Promise<void> {
    const operation = this.reconciliationTail.then(() => this.reconcileNow(next));
    this.reconciliationTail = operation.catch(() => undefined);
    return operation;
  }

  async close(): Promise<void> {
    const leases = await this.withGate(async () => {
      this.stopped = true;
      this.blockAll = true;
      const active = [...this.leases.values()];
      for (const lease of active)
        lease.controller.abort(new DOMException("Runtime stopped", "AbortError"));
      return active;
    });
    await Promise.all(leases.map((lease) => lease.settled));
    await this.options.runtime.dispose();
  }

  private async reconcileNow(next: Config): Promise<void> {
    const removedClients = removedIds(this.desired.clients, next.clients);
    const changedClients = changedClientIds(this.desired, next);
    const removedWorkspaces = removedIds(this.desired.workspaces, next.workspaces);
    const changedWorkspaces = changedWorkspaceIds(this.desired, next);
    const affectedClients = new Set([...removedClients, ...changedClients]);
    const affectedWorkspaces = new Set([...removedWorkspaces, ...changedWorkspaces]);
    const leases = await this.withGate(async () => {
      for (const id of affectedClients) this.blockedClients.add(id);
      for (const id of affectedWorkspaces) this.blockedWorkspaces.add(id);
      const active = [...this.leases.values()].filter(
        (lease) => affectedClients.has(lease.clientId) || affectedWorkspaces.has(lease.workspaceId),
      );
      for (const lease of active)
        lease.controller.abort(new DOMException("Runtime scope retired", "AbortError"));
      return active;
    });
    let completed = false;
    try {
      await Promise.all(leases.map((lease) => lease.settled));
      for (const clientId of affectedClients) await this.options.runtime.disposeClient(clientId);
      for (const workspaceId of affectedWorkspaces)
        await this.options.runtime.disposeWorkspace(workspaceId);
      for (const clientId of removedClients) {
        await purgeClientRuntimeSessions(clientId, this.options.sessions);
      }
      for (const workspaceId of affectedWorkspaces) {
        await purgeWorkspaceRuntimeSessions(workspaceId, this.options.sessions);
      }
      completed = true;
    } finally {
      if (completed) {
        await this.withGate(async () => {
          this.desired = next;
          for (const id of affectedClients) this.blockedClients.delete(id);
          for (const id of affectedWorkspaces) this.blockedWorkspaces.delete(id);
        });
      }
    }
  }

  private async withGate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.gateTail;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.gateTail = previous.then(() => held);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function createLease(clientId: string, workspaceId: string): RuntimeLease {
  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  return {
    id: randomUUID(),
    clientId,
    workspaceId,
    controller: new AbortController(),
    settled,
    resolveSettled,
  };
}

function removedIds(previous: Array<{ id: string }>, next: Array<{ id: string }>): string[] {
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
