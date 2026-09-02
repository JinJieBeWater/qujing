import { join } from "node:path";
import { Effect, Exit, Scope, Semaphore } from "effect";
import { securePrivatePathEffect, writePrivateJsonEffect } from "../private-files";
import { decode, TailcatState as TailcatStateSchema } from "../schemas";
import {
  startServerTransportEffect,
  type ServerTransportOptions,
  type TransportProcess,
} from "./process";

const parseTailcatState = decode(TailcatStateSchema);
export const readTailcatStateEffect = (stateRoot: string) =>
  Effect.tryPromise({
    try: async () =>
      parseTailcatState(
        JSON.parse(await Bun.file(join(stateRoot, "transport", "server.json")).text()),
      ),
    catch: (error) => error,
  }).pipe(
    Effect.catchEager((error) =>
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? Effect.succeed(undefined)
        : Effect.fail(error),
    ),
  );
export interface TailcatSupervisorOptions {
  stateRoot: string;
  port: number;
  binary?: string;
  startEffect?: (
    options: ServerTransportOptions,
    binary?: string,
  ) => Effect.Effect<TransportProcess, unknown>;
  onFatal?: (error: Error) => void;
}

export class TailcatSupervisor {
  private readonly statePath: string;
  private readonly keyPath: string;
  private readonly gate = Semaphore.makeUnsafe(1);
  private readonly scope = Scope.makeUnsafe("sequential");
  private process: TransportProcess | undefined;
  private signature?: string;
  private closed = false;

  constructor(private readonly options: TailcatSupervisorOptions) {
    this.statePath = join(options.stateRoot, "transport", "server.json");
    this.keyPath = join(options.stateRoot, "transport", "server-key.json");
  }

  reloadEffect(allowedKeys: string[]) {
    const keys = [...new Set(allowedKeys)].sort();
    const signature = JSON.stringify(keys);
    return this.gate.withPermits(1)(
      Effect.gen({ self: this }, function* () {
        if (this.closed) return yield* Effect.fail(new Error("Tailcat transport is closed"));
        if (signature === this.signature) return yield* this.stateEffect();
        const previousProcess = this.process;
        this.process = undefined;
        yield* closeEffect(previousProcess);
        const transportOptions = {
          keyPath: this.keyPath,
          port: this.options.port,
          allowedKeys: keys,
        };
        const transport = yield* this.options.startEffect
          ? this.options.startEffect(transportOptions, this.options.binary)
          : startServerTransportEffect(transportOptions, this.options.binary);
        const serverAddress = transport.ready.serverAddress;
        if (!serverAddress) {
          yield* closeEffect(transport);
          return yield* Effect.fail(new Error("Tailcat transport returned no server address"));
        }
        const previous = yield* readTailcatStateEffect(this.options.stateRoot);
        if (previous && previous.serverAddress !== serverAddress) {
          yield* closeEffect(transport);
          return yield* Effect.fail(
            new Error("Tailcat server address changed despite persistent key"),
          );
        }
        const state = { serverAddress, remotePort: this.options.port };
        yield* securePrivatePathEffect(this.keyPath, false);
        yield* writePrivateJsonEffect(this.statePath, state);
        this.process = transport;
        this.signature = signature;
        yield* this.watchEffect(transport);
        return state;
      }),
    );
  }

  stateEffect() {
    return readTailcatStateEffect(this.options.stateRoot).pipe(
      Effect.flatMap((state) =>
        state ? Effect.succeed(state) : Effect.fail(new Error("Tailcat server has not started")),
      ),
    );
  }
  closeEffect() {
    return this.gate.withPermits(1)(
      Effect.gen({ self: this }, function* () {
        this.closed = true;
        yield* closeEffect(this.process);
        this.process = undefined;
        yield* Scope.close(this.scope, Exit.void);
      }),
    );
  }

  private watchEffect(transport: TransportProcess) {
    return Effect.forkIn(
      transport.exitedEffect.pipe(
        Effect.flatMap((code) =>
          Effect.sync(() => {
            if (!this.closed && this.process === transport)
              (this.options.onFatal ?? defaultFatal)(
                new Error(`Tailcat transport exited (${code})`),
              );
          }),
        ),
      ),
      this.scope,
    );
  }
}

const closeEffect = (transport?: TransportProcess) =>
  transport ? transport.closeEffect().pipe(Effect.catchEager(() => Effect.void)) : Effect.void;
function defaultFatal(): void {
  process.exit(1);
}
