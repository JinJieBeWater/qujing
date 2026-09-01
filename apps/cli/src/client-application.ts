import { createHash } from "node:crypto";
import { z } from "zod";
import type { ClientConfig, ClientConfigStore, LineConfig } from "./client-config";
import { ColleagueLineError } from "./errors";
import { LineRuntime } from "./line-runtime";
import type { OwnerMetadata, PublicWorkspace } from "./types";

const questionSchema = z
  .string()
  .max(20_000)
  .refine((value) => value.trim().length > 0);

export interface ClientLine {
  id: string;
  available: boolean;
  owner?: OwnerMetadata;
  workspaces: PublicWorkspace[];
}

export interface ClientAskResult {
  line: string;
  workspace: string;
  answer: string;
}

export interface LineRuntimeClient {
  listWorkspaces(signal?: AbortSignal): ReturnType<LineRuntime["listWorkspaces"]>;
  ask(workspace: string, question: string, signal?: AbortSignal): ReturnType<LineRuntime["ask"]>;
  close(): Promise<void>;
}

export interface ClientApplicationOptions {
  config: Pick<ClientConfigStore, "read">;
  createRuntime?: (line: LineConfig) => LineRuntimeClient;
}

interface RuntimeEntry {
  fingerprint: string;
  runtime: LineRuntimeClient;
}

interface OperationLease {
  controller: AbortController;
  signal: AbortSignal;
  settled: Promise<void>;
  finish(): void;
}

export class ClientApplication {
  private readonly runtimes = new Map<string, RuntimeEntry>();
  private readonly active = new Map<string, Set<OperationLease>>();
  private readonly blocked = new Map<string, string>();
  private readonly createRuntime: (line: LineConfig) => LineRuntimeClient;
  private gate = Promise.resolve();
  private closed = false;

  constructor(private readonly options: ClientApplicationOptions) {
    this.createRuntime = options.createRuntime ?? ((line) => new LineRuntime({ line }));
  }

  reconcile(): Promise<ClientConfig> {
    return this.withGate(async () => {
      this.assertOpen();
      const config = await this.options.config.read();
      await this.reconcileLocked(config);
      return config;
    });
  }

  async listLines(signal?: AbortSignal): Promise<ClientLine[]> {
    signal?.throwIfAborted();
    const lines = await this.withGate(async () => {
      this.assertOpen();
      const config = await this.options.config.read();
      await this.reconcileLocked(config);
      return config.lines.map((line) => {
        if (this.blocked.has(line.id)) return { line };
        return {
          line,
          runtime: this.runtimeLocked(line),
          lease: this.beginOperationLocked(line.id, signal),
        };
      });
    });
    return Promise.all(
      lines.map(async ({ line, runtime, lease }) => {
        if (!runtime || !lease) return { id: line.id, available: false, workspaces: [] };
        try {
          const listed = await runtime.listWorkspaces(lease.signal);
          return {
            id: line.id,
            available: true,
            owner: owner(listed.owner),
            workspaces: listed.workspaces,
          };
        } catch (error) {
          if (isAbort(error)) throw error;
          return { id: line.id, available: false, workspaces: [] };
        } finally {
          lease.finish();
        }
      }),
    );
  }

  async ask(
    input: { line: string; workspace: string; question: string },
    signal?: AbortSignal,
  ): Promise<ClientAskResult> {
    if (!questionSchema.safeParse(input.question).success)
      throw new ColleagueLineError("INVALID_QUESTION", "Question is invalid");
    signal?.throwIfAborted();
    const { line, runtime, lease } = await this.withGate(async () => {
      this.assertOpen();
      const config = await this.options.config.read();
      await this.reconcileLocked(config);
      const line = config.lines.find((entry) => entry.id === input.line);
      if (!line) throw new ColleagueLineError("LINE_NOT_FOUND", "Line not found");
      if (this.blocked.has(line.id)) throw lineUnavailable();
      return {
        line,
        runtime: this.runtimeLocked(line),
        lease: this.beginOperationLocked(line.id, signal),
      };
    });
    try {
      const result = await runtime.ask(input.workspace, input.question, lease.signal);
      return { line: line.id, workspace: result.workspace, answer: result.answer };
    } finally {
      lease.finish();
    }
  }

  retireLine(id: string, expectedFingerprint: string): Promise<void> {
    return this.withGate(async () => {
      this.assertOpen();
      const config = await this.options.config.read();
      const line = config.lines.find((entry) => entry.id === id);
      if (!line || lineFingerprint(line) !== expectedFingerprint)
        throw new Error("Line changed before retirement completed");
      this.blocked.set(id, expectedFingerprint);
      await this.retireRuntimeLocked(id, lineUnavailable());
    });
  }

  resumeLine(id: string, expectedFingerprint: string): Promise<void> {
    return this.withGate(async () => {
      if (this.blocked.get(id) === expectedFingerprint) this.blocked.delete(id);
    });
  }

  close(): Promise<void> {
    return this.withGate(async () => {
      if (this.closed) return;
      this.closed = true;
      const ids = new Set([...this.runtimes.keys(), ...this.active.keys()]);
      await settleAll([...ids].map((id) => this.retireRuntimeLocked(id, lineUnavailable())));
      this.blocked.clear();
    });
  }

  private async reconcileLocked(config: ClientConfig): Promise<void> {
    const current = new Map(config.lines.map((line) => [line.id, lineFingerprint(line)]));
    for (const [id, expected] of this.blocked) {
      if (current.get(id) !== expected) this.blocked.delete(id);
    }
    const stale = [...this.runtimes].filter(([id, entry]) => current.get(id) !== entry.fingerprint);
    await Promise.allSettled(stale.map(([id]) => this.retireRuntimeLocked(id, lineUnavailable())));
  }

  private runtimeLocked(line: LineConfig): LineRuntimeClient {
    const fingerprint = lineFingerprint(line);
    const current = this.runtimes.get(line.id);
    if (current?.fingerprint === fingerprint) return current.runtime;
    const runtime = this.createRuntime(line);
    this.runtimes.set(line.id, { fingerprint, runtime });
    return runtime;
  }

  private beginOperationLocked(id: string, signal?: AbortSignal): OperationLease {
    const controller = new AbortController();
    let settle!: () => void;
    let finished = false;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const lease: OperationLease = {
      controller,
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      settled,
      finish: () => {
        if (finished) return;
        finished = true;
        const leases = this.active.get(id);
        leases?.delete(lease);
        if (leases?.size === 0) this.active.delete(id);
        settle();
      },
    };
    const leases = this.active.get(id) ?? new Set<OperationLease>();
    leases.add(lease);
    this.active.set(id, leases);
    return lease;
  }

  private async retireRuntimeLocked(id: string, reason: Error): Promise<void> {
    const entry = this.runtimes.get(id);
    this.runtimes.delete(id);
    const leases = [...(this.active.get(id) ?? [])];
    for (const lease of leases) lease.controller.abort(reason);
    await settleAll([
      ...(entry ? [entry.runtime.close()] : []),
      ...leases.map((lease) => lease.settled),
    ]);
  }

  private assertOpen(): void {
    if (this.closed) throw new ColleagueLineError("LINE_UNAVAILABLE", "Client is stopped");
  }

  private async withGate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.gate;
    let release!: () => void;
    this.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export function lineFingerprint(line: LineConfig): string {
  return createHash("sha256").update(JSON.stringify(line)).digest("hex");
}

async function settleAll(operations: Promise<unknown>[]): Promise<void> {
  const failures = (await Promise.allSettled(operations))
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length > 0) throw new AggregateError(failures, "Line retirement failed");
}

function owner(value: { id: string; name: string; summary?: string | undefined }): OwnerMetadata {
  return value.summary === undefined
    ? { id: value.id, name: value.name }
    : { ...value, summary: value.summary };
}

function lineUnavailable(): ColleagueLineError {
  return new ColleagueLineError("LINE_UNAVAILABLE", "Line unavailable");
}

function isAbort(error: unknown): error is DOMException {
  return error instanceof DOMException && error.name === "AbortError";
}
