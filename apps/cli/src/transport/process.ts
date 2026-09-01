import { access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { securePrivatePath } from "../private-files";

export interface ServerTransportOptions {
  keyPath: string;
  port: number;
  allowedKeys: string[];
}

export function serverArgs(options: ServerTransportOptions): string[] {
  const allowed = options.allowedKeys.length === 0 ? ["none"] : options.allowedKeys;
  return [
    "serve",
    "--key",
    options.keyPath,
    "--port",
    String(options.port),
    ...allowed.flatMap((key) => ["--allow", key]),
  ];
}

export interface ConnectorOptions {
  serverAddress: string;
  remotePort: number;
  keyPath: string;
  localHost: "127.0.0.1";
  localPort: number;
}

export function connectorArgs(profile: ConnectorOptions): string[] {
  return [
    "connect",
    "--server",
    profile.serverAddress,
    "--port",
    String(profile.remotePort),
    "--key",
    profile.keyPath,
    "--listen",
    `${profile.localHost}:${profile.localPort}`,
  ];
}

export function transportBinaryPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.COLLEAGUE_LINE_TRANSPORT_BIN) return env.COLLEAGUE_LINE_TRANSPORT_BIN;
  const source = join(
    import.meta.dir,
    "..",
    "..",
    "native",
    "transport",
    "bin",
    process.platform === "win32" ? "colleague-line-transport.exe" : "colleague-line-transport",
  );
  return existsSync(source)
    ? source
    : join(
        dirname(process.execPath),
        process.platform === "win32" ? "colleague-line-transport.exe" : "colleague-line-transport",
      );
}

export async function requireTransportBinary(path = transportBinaryPath()): Promise<string> {
  await access(path).catch(() => {
    throw new Error(`Tailcat transport binary not found: ${path}. Run: bun run build:transport`);
  });
  return path;
}

interface ReadyMessage {
  ready: true;
  serverAddress?: string;
  remotePort?: number;
  localAddress?: string;
  publicKey?: string;
  keyPath?: string;
}

export interface TransportProcess {
  readonly ready: ReadyMessage;
  readonly exited: Promise<number>;
  close(): Promise<void>;
}

export async function startServerTransport(
  options: ServerTransportOptions,
  binary?: string,
): Promise<TransportProcess> {
  return startTransport(serverArgs(options), binary);
}

export async function startConnector(
  profile: ConnectorOptions,
  binary?: string,
  signal?: AbortSignal,
): Promise<TransportProcess> {
  return startTransport(connectorArgs(profile), binary, false, undefined, signal);
}

export async function createTransportKey(
  output: string,
  binary?: string,
): Promise<{ publicKey: string; keyPath: string }> {
  const process = await startTransport(["key-create", "--output", output], binary, true);
  const code = await process.exited;
  if (code !== 0 || !process.ready.publicKey || !process.ready.keyPath)
    throw new Error("Tailcat key generation failed");
  await securePrivatePath(output, false);
  return { publicKey: process.ready.publicKey, keyPath: process.ready.keyPath };
}

export async function validateTransportKey(key: string, binary?: string): Promise<void> {
  const process = await startTransport(["key-validate"], binary, true, `${key}\n`);
  if ((await process.exited) !== 0) throw new Error("Invalid Tailcat public key");
}

async function startTransport(
  args: string[],
  binary?: string,
  expectExit = false,
  input?: string,
  signal?: AbortSignal,
): Promise<TransportProcess> {
  signal?.throwIfAborted();
  const executable = await requireTransportBinary(binary);
  signal?.throwIfAborted();
  const child = Bun.spawn([executable, ...args], {
    stdin: input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (input !== undefined) {
    if (!child.stdin) throw new Error("Could not open Tailcat transport stdin");
    child.stdin.write(input);
    child.stdin.end();
  }
  void drainStderr(child.stderr, process.env.COLLEAGUE_LINE_TRANSPORT_DEBUG === "1");
  const abort = () => child.kill("SIGKILL");
  signal?.addEventListener("abort", abort, { once: true });
  let readinessTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const readiness = [
      readReady(child.stdout),
      new Promise<never>((_, reject) => {
        readinessTimer = setTimeout(
          () => reject(new Error("Tailcat transport readiness timeout")),
          35_000,
        );
      }),
    ];
    if (!expectExit)
      readiness.push(
        child.exited.then((code) =>
          Promise.reject(new Error(`Tailcat transport exited before ready (${code})`)),
        ),
      );
    if (signal)
      readiness.push(
        new Promise<never>((_, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
      );
    const ready = await Promise.race(readiness);
    clearTimeout(readinessTimer);
    signal?.throwIfAborted();
    if (!expectExit && child.exitCode !== null)
      throw new Error(`Tailcat transport exited before ready (${child.exitCode})`);
    return {
      ready,
      exited: child.exited,
      async close() {
        if (child.exitCode !== null) return;
        child.kill("SIGTERM");
        let forceTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          child.exited,
          new Promise<void>((resolve) => {
            forceTimer = setTimeout(() => {
              child.kill("SIGKILL");
              resolve();
            }, 5_000);
          }),
        ]);
        clearTimeout(forceTimer);
      },
    };
  } catch (error) {
    clearTimeout(readinessTimer);
    child.kill("SIGKILL");
    await child.exited.catch(() => undefined);
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

async function drainStderr(stderr: ReadableStream<Uint8Array>, mirror: boolean): Promise<void> {
  const reader = stderr.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (mirror) process.stderr.write(value);
    }
  } finally {
    reader.releaseLock();
  }
}

async function readReady(stdout: ReadableStream<Uint8Array>): Promise<ReadyMessage> {
  const reader = stdout.getReader();
  let bytes = Buffer.alloc(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) throw new Error("Tailcat transport produced no readiness message");
    bytes = Buffer.concat([bytes, value]);
    const newline = bytes.indexOf(0x0a);
    if (newline < 0) {
      if (bytes.length > 16_384)
        throw new Error("Tailcat transport readiness message is too large");
      continue;
    }
    const parsed = JSON.parse(bytes.subarray(0, newline).toString("utf8")) as ReadyMessage;
    if (parsed.ready !== true) throw new Error("Invalid Tailcat transport readiness message");
    reader.releaseLock();
    return parsed;
  }
}
