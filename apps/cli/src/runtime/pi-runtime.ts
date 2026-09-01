import type { WorkspaceConfig } from "../config";
import { ABORT_SETTLE_TIMEOUT_MS, ASK_TIMEOUT_MS } from "../constants";
import { ColleagueLineError } from "../errors";
import { startPiRpcSession } from "./pi-rpc";
import type { RuntimeSession } from "./sessions";

export interface ManagedPiSession {
  prompt(question: string): Promise<void>;
  getLastAssistantText(): string | undefined;
  isAlive(): boolean;
  clearQueue(): Promise<void>;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  dispose(): Promise<void>;
}

export interface PiRuntimeAnswerInput {
  workspace: WorkspaceConfig;
  session: RuntimeSession;
  question: string;
  signal: AbortSignal;
}

interface RuntimeEntry {
  session: ManagedPiSession;
  clientId: string;
  workspaceId: string;
  busy: boolean;
  waiting: number;
  tail: Promise<void>;
  lastUsed: number;
}

interface RuntimeCreation {
  clientId: string;
  workspaceId: string;
  retired: boolean;
  promise: Promise<RuntimeEntry>;
}

export interface PiRuntimeOptions {
  createSession(workspace: WorkspaceConfig, session: RuntimeSession): Promise<ManagedPiSession>;
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

export class PiRuntime {
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly creations = new Map<string, RuntimeCreation>();
  private readonly retirements = new Set<Promise<void>>();
  private readonly interval: ReturnType<typeof setInterval>;
  private disposed = false;

  constructor(private readonly options: PiRuntimeOptions) {
    process.umask(0o077);
    this.interval = setInterval(
      () => {
        void this.sweepIdle().catch((error: unknown) => {
          const failure = error instanceof Error ? error : new Error(String(error));
          if (this.options.fatal) this.options.fatal(failure);
          else process.exit(1);
        });
      },
      Math.min(options.idleTimeoutMs ?? 600_000, 60_000),
    );
    this.interval.unref?.();
  }

  static async create(
    options: {
      piBinary?: string;
      fatal?: (error: Error) => void;
    } = {},
  ): Promise<PiRuntime> {
    return new PiRuntime({
      ...(options.fatal === undefined ? {} : { fatal: options.fatal }),
      createSession: (workspace, session) =>
        startPiRpcSession({
          cwd: workspace.root,
          sessionId: session.id,
          ...(options.piBinary === undefined ? {} : { binary: options.piBinary }),
        }),
    });
  }

  async answer(input: PiRuntimeAnswerInput): Promise<{ answer: string }> {
    if (this.disposed) throw new ColleagueLineError("RUNTIME_UNAVAILABLE", "Runtime is stopped");
    const timeoutSignal = (this.options.createTimeoutSignal ?? AbortSignal.timeout)(
      this.options.askTimeoutMs ?? ASK_TIMEOUT_MS,
    );
    const signal = AbortSignal.any([input.signal, timeoutSignal]);
    try {
      signal.throwIfAborted();
      while (true) {
        const entry = await waitFor(this.getEntry(input.workspace, input.session), signal);
        const release = deferred();
        const previous = entry.tail;
        entry.tail = previous.then(() => release.promise);
        if (entry.waiting >= (this.options.queueCapacity ?? 20)) {
          release.resolve();
          throw new ColleagueLineError("BUSY", "Runtime Session queue is full");
        }
        entry.waiting++;
        let acquired = false;
        let running = false;
        try {
          await waitFor(previous, signal);
          acquired = true;
          entry.waiting--;
          if (this.entries.get(input.session.id) !== entry) continue;
          if (!entry.session.isAlive()) {
            await this.evict(entry);
            continue;
          }
          entry.busy = true;
          running = true;
          const answer = await this.runTurn(entry, input.question, signal);
          return { answer };
        } finally {
          if (!acquired) entry.waiting--;
          if (running) {
            entry.busy = false;
            entry.lastUsed = this.now();
          }
          release.resolve();
        }
      }
    } catch (error) {
      if (timeoutSignal.aborted && !input.signal.aborted) {
        throw new ColleagueLineError("RUNTIME_TIMEOUT", "Runtime timed out");
      }
      if (input.signal.aborted) throw input.signal.reason;
      throw error;
    }
  }

  async disposeRuntimeSession(id: string): Promise<void> {
    const creation = this.creations.get(id);
    if (creation) {
      creation.retired = true;
      await this.waitForRetiredCreations([creation]);
    }
    const entry = this.entries.get(id);
    if (!entry) return;
    await this.retireEntry(id, entry, entry.busy || entry.waiting > 0);
  }

  async disposeClient(clientId: string): Promise<void> {
    await this.retireCreations((creation) => creation.clientId === clientId);
    await Promise.all(
      [...this.entries]
        .filter(([, entry]) => entry.clientId === clientId)
        .map(([id]) => this.disposeRuntimeSession(id)),
    );
  }

  async disposeWorkspace(workspaceId: string): Promise<void> {
    await this.retireCreations((creation) => creation.workspaceId === workspaceId);
    await Promise.all(
      [...this.entries]
        .filter(([, entry]) => entry.workspaceId === workspaceId)
        .map(([id]) => this.disposeRuntimeSession(id)),
    );
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    clearInterval(this.interval);
    await this.retireCreations(() => true);
    await Promise.all([...this.entries.keys()].map((id) => this.disposeRuntimeSession(id)));
    await Promise.all(this.retirements);
  }

  private async runTurn(
    entry: RuntimeEntry,
    question: string,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      await this.promptWithAbort(entry.session, question, signal);
      const answer = entry.session.getLastAssistantText();
      if (!answer) throw new ColleagueLineError("RUNTIME_FAILED", "Runtime returned no answer");
      return answer;
    } catch (error) {
      if (!entry.session.isAlive()) await this.evict(entry);
      if (signal.aborted) throw signal.reason;
      if (error instanceof ColleagueLineError) throw error;
      throw new ColleagueLineError("RUNTIME_FAILED", "Runtime failed", {
        cause: error,
      });
    }
  }

  private async evict(entry: RuntimeEntry): Promise<void> {
    for (const [id, candidate] of this.entries) {
      if (candidate === entry) {
        await this.retireEntry(id, entry, false);
        return;
      }
    }
  }

  private retireEntry(id: string, entry: RuntimeEntry, abort: boolean): Promise<void> {
    if (this.entries.get(id) !== entry) return Promise.resolve();
    this.entries.delete(id);
    let retirement!: Promise<void>;
    retirement = (async () => {
      try {
        if (abort) await this.abortSession(entry.session);
        await entry.session.dispose();
      } finally {
        this.retirements.delete(retirement);
      }
    })();
    this.retirements.add(retirement);
    return retirement;
  }

  private async promptWithAbort(
    session: ManagedPiSession,
    question: string,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    let abortTask: Promise<void> | undefined;
    let rejectAbort: ((error: unknown) => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => {
      abortTask = this.abortSession(session);
      void abortTask.then(() => rejectAbort?.(signal.reason), rejectAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await Promise.race([session.prompt(question), aborted]);
      if (signal.aborted) {
        await (abortTask ?? this.abortSession(session));
        throw signal.reason;
      }
    } catch (error) {
      if (signal.aborted) {
        await abortTask;
        throw signal.reason;
      }
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  private async abortSession(session: ManagedPiSession): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let completed: boolean;
    try {
      completed = await Promise.race([
        session
          .clearQueue()
          .then(() => session.abort())
          .then(() => session.waitForIdle())
          .then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(
            () => resolve(false),
            this.options.abortTimeoutMs ?? ABORT_SETTLE_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (error) {
      clearTimeout(timer);
      const failure = new Error("Pi Runtime abort failed", { cause: error });
      if (this.options.fatal) this.options.fatal(failure);
      else process.exit(1);
      throw failure;
    }
    clearTimeout(timer);
    if (completed) return;
    const error = new Error("Pi Runtime did not settle after abort");
    if (this.options.fatal) this.options.fatal(error);
    else process.exit(1);
    throw error;
  }

  private async getEntry(
    workspace: WorkspaceConfig,
    session: RuntimeSession,
  ): Promise<RuntimeEntry> {
    if (this.disposed) throw new ColleagueLineError("RUNTIME_UNAVAILABLE", "Runtime is stopped");
    const existing = this.entries.get(session.id);
    if (existing) return existing;
    const activeCreation = this.creations.get(session.id);
    if (activeCreation) return activeCreation.promise;
    let evicted: RuntimeEntry | undefined;
    if (
      this.entries.size + this.creations.size + this.retirements.size >=
      (this.options.maxRuntimes ?? 4)
    ) {
      const idle = [...this.entries.entries()]
        .filter(([, entry]) => !entry.busy && entry.waiting === 0)
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!idle) throw new ColleagueLineError("BUSY", "All Runtime slots are active");
      this.entries.delete(idle[0]);
      evicted = idle[1];
    }
    const creation = {
      clientId: session.clientId,
      workspaceId: session.workspaceId,
      retired: false,
      promise: undefined as unknown as Promise<RuntimeEntry>,
    };
    this.creations.set(session.id, creation);
    creation.promise = Promise.resolve().then(() =>
      this.createEntry(workspace, session, creation, evicted),
    );
    return creation.promise;
  }

  private async createEntry(
    workspace: WorkspaceConfig,
    session: RuntimeSession,
    creation: RuntimeCreation,
    evicted?: RuntimeEntry,
  ): Promise<RuntimeEntry> {
    let managed: ManagedPiSession | undefined;
    try {
      await evicted?.session.dispose();
      managed = await this.options.createSession(workspace, session);
      if (creation.retired || this.disposed) {
        throw new DOMException("Runtime Session creation retired", "AbortError");
      }
      const entry = {
        session: managed,
        clientId: session.clientId,
        workspaceId: session.workspaceId,
        busy: false,
        waiting: 0,
        tail: Promise.resolve(),
        lastUsed: this.now(),
      };
      this.entries.set(session.id, entry);
      managed = undefined;
      return entry;
    } catch (error) {
      await managed?.dispose();
      if (creation.retired || this.disposed) throw error;
      throw new ColleagueLineError("RUNTIME_UNAVAILABLE", "Could not start Pi Runtime", {
        cause: error,
      });
    } finally {
      if (this.creations.get(session.id) === creation) this.creations.delete(session.id);
    }
  }

  private async retireCreations(predicate: (creation: RuntimeCreation) => boolean): Promise<void> {
    const matching = [...this.creations.values()].filter(predicate);
    for (const creation of matching) creation.retired = true;
    await this.waitForRetiredCreations(matching);
  }

  private async waitForRetiredCreations(creations: RuntimeCreation[]): Promise<void> {
    if (creations.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const completed = await Promise.race([
      Promise.allSettled(creations.map((creation) => creation.promise)).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(
          () => resolve(false),
          this.options.creationRetireTimeoutMs ?? ABORT_SETTLE_TIMEOUT_MS,
        );
      }),
    ]);
    clearTimeout(timer);
    if (completed) return;
    const error = new Error("Pi Runtime Session creation did not settle during retirement");
    if (this.options.fatal) this.options.fatal(error);
    else process.exit(1);
    throw error;
  }

  private async sweepIdle(): Promise<void> {
    const cutoff = this.now() - (this.options.idleTimeoutMs ?? 600_000);
    for (const [id, entry] of this.entries) {
      if (entry.busy || entry.waiting > 0 || entry.lastUsed > cutoff) continue;
      await this.retireEntry(id, entry, false);
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
