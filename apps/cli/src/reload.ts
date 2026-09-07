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

export const acknowledgeNodeReloadEffect = (stateRoot: string, config: Config) =>
  writePrivateJsonEffect(join(stateRoot, "node-reload.json"), {
    configFingerprint: configFingerprint(config),
    updatedAt: new Date().toISOString(),
  });

export function waitForNodeReloadEffect(
  store: ConfigStore,
  stateRoot: string,
  predicate: (config: Config) => boolean,
  timeoutMs = 45_000,
): Effect.Effect<boolean, unknown> {
  return waitForReloadEffect(
    Effect.gen(function* () {
      const config = yield* store.readEffectiveEffect();
      if (!predicate(config))
        return yield* Effect.fail(new Error("Configuration changed before Node reload completed"));
      return configFingerprint(config);
    }),
    stateRoot,
    "node",
    timeoutMs,
    "Timed out waiting for Node cancellation and transport reload",
  );
}

export function configFingerprint(config: unknown): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

export const acknowledgeAgentReloadEffect = (
  stateRoot: string,
  config: import("./agent-config").AgentConfig,
): Effect.Effect<void, unknown> =>
  writePrivateJsonEffect(join(stateRoot, "agent-reload.json"), {
    configFingerprint: configFingerprint(config),
    updatedAt: new Date().toISOString(),
  });

export function waitForAgentReloadEffect(
  store: import("./agent-config").AgentConfigStore,
  stateRoot: string,
  expected: import("./agent-config").AgentConfig,
  timeoutMs = 45_000,
): Effect.Effect<boolean, unknown> {
  return waitForReloadEffect(
    Effect.gen(function* () {
      const config = yield* store.readEffect();
      if (configFingerprint(config) !== configFingerprint(expected))
        return yield* Effect.fail(new Error("Configuration changed before Agent reload completed"));
      return configFingerprint(config);
    }),
    stateRoot,
    "agent",
    timeoutMs,
    "Timed out waiting for Agent Peer and credential reload",
  );
}

function waitForReloadEffect(
  fingerprintEffect: Effect.Effect<string, unknown>,
  stateRoot: string,
  role: "node" | "agent",
  timeoutMs: number,
  timeoutMessage: string,
): Effect.Effect<boolean, unknown> {
  const deadline = Date.now() + timeoutMs;
  return Effect.gen(function* () {
    for (;;) {
      const fingerprint = yield* fingerprintEffect;
      const state = yield* Effect.tryPromise({
        try: () => readReloadStateFile(join(stateRoot, `${role}-reload.json`)),
        catch: (error) => error,
      });
      if (state?.configFingerprint === fingerprint) return true;
      if (!(yield* processLockActiveEffect(join(stateRoot, `${role}.lock`)))) return false;
      if (Date.now() >= deadline) return yield* Effect.fail(new Error(timeoutMessage));
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
