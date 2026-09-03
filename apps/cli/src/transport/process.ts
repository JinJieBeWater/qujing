import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner";
import { Duration, Effect, Exit, Layer, Option, Scope, Stream } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { PlatformLayer } from "../effect-runtime";
import { securePrivatePathEffect } from "../private-files";
import {
  decode,
  TransportReady as TransportReadySchema,
  type TransportReady as TransportReadyData,
} from "../schemas";

const ProcessLayer = Layer.merge(
  PlatformLayer,
  Layer.provide(BunChildProcessSpawner.layer, PlatformLayer),
);
const READINESS_TIMEOUT = Duration.seconds(35);
const CLOSE_TIMEOUT = Duration.seconds(5);

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
  if (env.QUJING_TRANSPORT_BIN) return env.QUJING_TRANSPORT_BIN;
  const source = join(
    import.meta.dir,
    "..",
    "..",
    "native",
    "transport",
    "bin",
    process.platform === "win32" ? "qujing-transport.exe" : "qujing-transport",
  );
  return existsSync(source)
    ? source
    : join(
        dirname(process.execPath),
        process.platform === "win32" ? "qujing-transport.exe" : "qujing-transport",
      );
}
export const requireTransportBinaryEffect = (path = transportBinaryPath()) =>
  Effect.tryPromise({
    try: async () => {
      const file = Bun.file(path);
      if (!(await file.exists()))
        throw new Error(
          `Tailcat transport binary not found: ${path}. Run: bun run build:transport`,
        );
      return path;
    },
    catch: (error) => error,
  });

const parseReadyMessage = decode(TransportReadySchema);
type ReadyMessage = TransportReadyData;
export interface TransportProcess {
  readonly ready: ReadyMessage;
  readonly exitedEffect: Effect.Effect<number>;
  closeEffect(): Effect.Effect<void>;
}
export const startServerTransportEffect = (options: ServerTransportOptions, binary?: string) =>
  startTransportEffect(serverArgs(options), binary);
export const startConnectorEffect = (
  profile: ConnectorOptions,
  binary?: string,
  signal?: AbortSignal,
) => startTransportEffect(connectorArgs(profile), binary, false, undefined, signal);
export const createTransportKeyEffect = (output: string, binary?: string) =>
  Effect.gen(function* () {
    const transport = yield* startTransportEffect(["key-create", "--output", output], binary, true);
    if (
      (yield* transport.exitedEffect) !== 0 ||
      !transport.ready.publicKey ||
      !transport.ready.keyPath
    )
      return yield* Effect.fail(new Error("Tailcat key generation failed"));
    yield* transport.closeEffect();
    yield* securePrivatePathEffect(output, false);
    return { publicKey: transport.ready.publicKey, keyPath: transport.ready.keyPath };
  });
export const validateTransportKeyEffect = (key: string, binary?: string) =>
  Effect.gen(function* () {
    const transport = yield* startTransportEffect(["key-validate"], binary, true, `${key}\n`);
    if ((yield* transport.exitedEffect) !== 0)
      return yield* Effect.fail(new Error("Invalid Tailcat public key"));
    yield* transport.closeEffect();
  });

const startTransportEffect = (
  args: string[],
  binary?: string,
  expectExit = false,
  input?: string,
  signal?: AbortSignal,
) =>
  Effect.gen(function* () {
    yield* abortEffect(signal);
    const executable = yield* requireTransportBinaryEffect(binary);
    yield* abortEffect(signal);
    const scope = yield* Scope.make("sequential");
    return yield* Effect.onExit(
      Effect.provideService(
        Effect.gen(function* () {
          const handle = yield* ChildProcess.make(executable, args, {
            stdin:
              input === undefined ? "ignore" : Stream.fromIterable([input]).pipe(Stream.encodeText),
            stdout: "pipe",
            stderr: "pipe",
          });
          const exitedEffect = handle.exitCode.pipe(
            Effect.map(Number),
            Effect.catchEager(() => Effect.succeed(-1)),
          );
          if (process.env.QUJING_TRANSPORT_DEBUG === "1")
            yield* Effect.forkIn(
              Stream.runForEach(handle.stderr, (chunk) =>
                Effect.sync(() => process.stderr.write(chunk)),
              ),
              scope,
            );
          else yield* Effect.forkIn(Stream.runDrain(handle.stderr), scope);
          const ready = yield* readReadyEffect(handle.stdout).pipe(
            Effect.timeoutOrElse({
              duration: READINESS_TIMEOUT,
              orElse: () => Effect.fail(new Error("Tailcat transport readiness timeout")),
            }),
            expectExit
              ? (effect) => effect
              : (effect) =>
                  Effect.raceFirst(
                    effect,
                    handle.exitCode.pipe(
                      Effect.flatMap((code) =>
                        Effect.fail(new Error(`Tailcat transport exited before ready (${code})`)),
                      ),
                    ),
                  ),
            (effect) => (signal ? Effect.raceFirst(effect, awaitAbortEffect(signal)) : effect),
          );
          yield* abortEffect(signal);
          const closeEffect = () =>
            handle.kill({ forceKillAfter: CLOSE_TIMEOUT }).pipe(
              Effect.catchEager(() => Effect.void),
              Effect.andThen(Scope.close(scope, Exit.void)),
            );
          return {
            ready,
            exitedEffect,
            closeEffect,
          } satisfies TransportProcess;
        }),
        Scope.Scope,
        scope,
      ),
      (exit) => (exit._tag === "Failure" ? Scope.close(scope, exit) : Effect.void),
    );
  }).pipe(Effect.provide(ProcessLayer));

function readReadyEffect(stdout: Stream.Stream<Uint8Array, unknown>) {
  return Stream.runHead(stdout.pipe(Stream.decodeText(), Stream.splitLines)).pipe(
    Effect.flatMap((line) =>
      Option.isSome(line)
        ? Effect.try({
            try: () => parseReadyMessage(JSON.parse(line.value)),
            catch: (error) => error,
          })
        : Effect.fail(new Error("Tailcat transport produced no readiness message")),
    ),
  );
}
function abortEffect(signal?: AbortSignal) {
  return signal
    ? Effect.try({ try: () => signal.throwIfAborted(), catch: (error) => error })
    : Effect.void;
}

function awaitAbortEffect(signal: AbortSignal): Effect.Effect<never, unknown> {
  return Effect.callback((resume) => {
    const abort = () => resume(Effect.fail(signal.reason));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", abort));
  });
}
