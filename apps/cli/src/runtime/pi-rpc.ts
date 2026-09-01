import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

interface RpcResponse {
  type: "response";
  id?: string;
  success: boolean;
  data?: unknown;
}

interface PendingRequest {
  resolve(response: RpcResponse): void;
  reject(error: Error): void;
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

export interface PiRpcSession {
  prompt(question: string): Promise<void>;
  getLastAssistantText(): string | undefined;
  isAlive(): boolean;
  clearQueue(): Promise<void>;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  dispose(): Promise<void>;
}

export function piBinaryPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.COLLEAGUE_LINE_PI_BIN || "pi";
}

export async function startPiRpcSession(options: {
  cwd: string;
  sessionId: string;
  binary?: string;
  startupTimeoutMs?: number;
}): Promise<PiRpcSession> {
  const child = spawn(
    options.binary ?? piBinaryPath(),
    ["--mode", "rpc", "--approve", "--session-id", options.sessionId],
    { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] },
  );
  const session = new GlobalPiRpcSession(child);
  try {
    const response = await withTimeout(
      session.command("get_state"),
      options.startupTimeoutMs ?? 30_000,
      "Global Pi startup timed out",
    );
    const state = response.data as { sessionId?: unknown } | undefined;
    if (state?.sessionId !== options.sessionId) throw new Error("Pi opened wrong Runtime Session");
    return session;
  } catch (error) {
    await session.dispose();
    throw error;
  }
}

class GlobalPiRpcSession implements PiRpcSession {
  private readonly pending = new Map<string, PendingRequest>();
  private stdoutBuffer = Buffer.alloc(0);
  private currentTurn: Deferred | undefined;
  private lastAssistantText: string | undefined;
  private failed = false;
  private stopped = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => this.read(chunk));
    child.stdout.on("end", () => {
      if (this.stdoutBuffer.length > 0) this.fail(new Error("Pi RPC ended with partial JSONL"));
    });
    child.stderr.resume();
    child.on("error", (error) =>
      this.fail(new Error("Could not start global Pi", { cause: error })),
    );
    child.on("exit", (code, signal) => {
      if (!this.stopped) this.fail(new Error(`Global Pi exited (${code ?? signal ?? "unknown"})`));
    });
  }

  async prompt(question: string): Promise<void> {
    if (this.currentTurn) throw new Error("Pi Runtime Session already has an active turn");
    const turn = deferred();
    this.currentTurn = turn;
    this.lastAssistantText = undefined;
    try {
      await this.command("prompt", { message: question });
      await turn.promise;
    } catch (error) {
      if (this.currentTurn === turn) this.currentTurn = undefined;
      throw error;
    }
  }

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

  async clearQueue(): Promise<void> {
    await this.command("clear_queue");
  }

  async abort(): Promise<void> {
    await this.command("abort");
  }

  async waitForIdle(): Promise<void> {
    await this.currentTurn?.promise;
  }

  async dispose(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      this.fail(new Error("Global Pi stopped"));
      return;
    }
    this.child.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      new Promise<void>((resolve) => this.child.once("exit", () => resolve())),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          this.child.kill("SIGKILL");
          resolve();
        }, 1_000);
      }),
    ]);
    clearTimeout(timer);
    this.fail(new Error("Global Pi stopped"));
  }

  async command(type: string, fields: Record<string, unknown> = {}): Promise<RpcResponse> {
    if (this.stopped) throw new Error("Global Pi is stopped");
    const id = randomUUID();
    const response = new Promise<RpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    try {
      await this.write({ type, id, ...fields });
    } catch (error) {
      this.pending.delete(id);
      const failure = error instanceof Error ? error : new Error(String(error));
      this.fail(failure);
      throw failure;
    }
    const result = await response;
    if (!result.success) throw new Error(`Pi RPC command failed: ${type}`);
    return result;
  }

  private read(chunk: Buffer): void {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    let newline = this.stdoutBuffer.indexOf(0x0a);
    while (newline !== -1) {
      const line = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      const end = line.at(-1) === 0x0d ? line.length - 1 : line.length;
      if (end > 0) this.handleLine(line.toString("utf8", 0, end));
      newline = this.stdoutBuffer.indexOf(0x0a);
    }
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch (error) {
      this.fail(new Error("Global Pi emitted invalid JSONL", { cause: error }));
      return;
    }
    if (message.type === "response" && typeof message.id === "string") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.resolve(message as unknown as RpcResponse);
      return;
    }
    if (message.type === "message_end") this.captureAssistant(message.message);
    if (message.type === "agent_settled") {
      const turn = this.currentTurn;
      this.currentTurn = undefined;
      turn?.resolve();
      return;
    }
    if (message.type === "extension_ui_request") {
      void this.answerUiRequest(message).catch((error: unknown) =>
        this.fail(error instanceof Error ? error : new Error(String(error))),
      );
    }
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

  private async answerUiRequest(request: Record<string, unknown>): Promise<void> {
    if (typeof request.id !== "string") return;
    if (request.method === "confirm") {
      await this.write({ type: "extension_ui_response", id: request.id, confirmed: true });
      return;
    }
    if (request.method === "select" && Array.isArray(request.options)) {
      const value = request.options.find((option): option is string => typeof option === "string");
      await this.write(
        value === undefined
          ? { type: "extension_ui_response", id: request.id, cancelled: true }
          : { type: "extension_ui_response", id: request.id, value },
      );
      return;
    }
    if (request.method === "input" || request.method === "editor") {
      const value =
        request.method === "editor" && typeof request.prefill === "string" ? request.prefill : "";
      await this.write({ type: "extension_ui_response", id: request.id, value });
    }
  }

  private write(message: Record<string, unknown>): Promise<void> {
    if (this.stopped || !this.child.stdin.writable)
      return Promise.reject(new Error("Global Pi is stopped"));
    return new Promise<void>((resolve, reject) => {
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private fail(error: Error): void {
    this.failed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.currentTurn?.reject(error);
    this.currentTurn = undefined;
  }
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}
