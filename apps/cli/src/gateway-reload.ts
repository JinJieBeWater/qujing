import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { ConfigStore, type Config } from "./config";
import { sleep } from "./effect-runtime";
import { writePrivateJsonEffect } from "./private-files";
import { processLockActiveEffect } from "./process-lock";
import { decode, ReloadState, type ReloadState as ReloadStateData } from "./schemas";

const parseReloadState = decode(ReloadState);

export const acknowledgeGatewayReloadEffect = (stateRoot: string, config: Config) =>
  writePrivateJsonEffect(join(stateRoot, "gateway-reload.json"), {
    configFingerprint: configFingerprint(config),
    updatedAt: new Date().toISOString(),
  });

export function waitForGatewayReloadEffect(
  store: ConfigStore,
  stateRoot: string,
  predicate: (config: Config) => boolean,
  timeoutMs = 45_000,
): Effect.Effect<boolean, unknown> {
  const deadline = Date.now() + timeoutMs;
  return Effect.gen(function* () {
    for (;;) {
      const config = yield* store.readEffectiveEffect();
      if (!predicate(config))
        return yield* Effect.fail(
          new Error("Configuration changed before Gateway reload completed"),
        );
      const state = yield* promise(() => readReloadState(stateRoot));
      if (state?.configFingerprint === configFingerprint(config)) return true;
      if (!(yield* processLockActiveEffect(join(stateRoot, "gateway.lock")))) return false;
      if (Date.now() >= deadline)
        return yield* Effect.fail(
          new Error("Timed out waiting for Gateway cancellation and transport reload"),
        );
      yield* sleep(50);
    }
  });
}

async function readReloadState(stateRoot: string): Promise<ReloadStateData | undefined> {
  return readReloadStateFile(join(stateRoot, "gateway-reload.json"));
}

export function configFingerprint(config: unknown): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

export const acknowledgeClientReloadEffect = (
  stateRoot: string,
  config: import("./client-config").ClientConfig,
): Effect.Effect<void, unknown> =>
  writePrivateJsonEffect(join(stateRoot, "client-reload.json"), {
    configFingerprint: configFingerprint(config),
    updatedAt: new Date().toISOString(),
  });

export function waitForClientReloadEffect(
  store: import("./client-config").ClientConfigStore,
  stateRoot: string,
  expected: import("./client-config").ClientConfig,
  timeoutMs = 45_000,
): Effect.Effect<boolean, unknown> {
  const deadline = Date.now() + timeoutMs;
  return Effect.gen(function* () {
    for (;;) {
      const config = yield* store.readEffect();
      if (configFingerprint(config) !== configFingerprint(expected))
        return yield* Effect.fail(
          new Error("Configuration changed before Client reload completed"),
        );
      const state = yield* promise(() =>
        readReloadStateFile(join(stateRoot, "client-reload.json")),
      );
      if (state?.configFingerprint === configFingerprint(config)) return true;
      if (!(yield* processLockActiveEffect(join(stateRoot, "client.lock")))) return false;
      if (Date.now() >= deadline)
        return yield* Effect.fail(
          new Error("Timed out waiting for Client Line and credential reload"),
        );
      yield* sleep(50);
    }
  });
}

async function readReloadStateFile(path: string): Promise<ReloadStateData | undefined> {
  try {
    return parseReloadState(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function promise<A>(try_: () => Promise<A>) {
  return Effect.tryPromise({ try: try_, catch: (error) => error });
}
