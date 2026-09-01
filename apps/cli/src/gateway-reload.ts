import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ConfigStore, type Config } from "./config";
import { writePrivateJson } from "./private-files";
import { processLockActive } from "./process-lock";

const reloadStateSchema = z.object({
  configFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  updatedAt: z.string().datetime(),
});

export async function acknowledgeGatewayReload(stateRoot: string, config: Config): Promise<void> {
  await writePrivateJson(join(stateRoot, "gateway-reload.json"), {
    configFingerprint: fingerprint(config),
    updatedAt: new Date().toISOString(),
  });
}

export async function waitForGatewayReload(
  store: ConfigStore,
  stateRoot: string,
  predicate: (config: Config) => boolean,
  timeoutMs = 45_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const config = await store.readEffective();
    if (!predicate(config))
      throw new Error("Configuration changed before Gateway reload completed");
    const state = await readReloadState(stateRoot);
    if (state?.configFingerprint === fingerprint(config)) return true;
    if (!(await processLockActive(join(stateRoot, "gateway.lock")))) return false;
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for Gateway cancellation and transport reload");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function readReloadState(
  stateRoot: string,
): Promise<z.infer<typeof reloadStateSchema> | undefined> {
  return readReloadStateFile(join(stateRoot, "gateway-reload.json"));
}

function fingerprint(config: unknown): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

export async function acknowledgeClientReload(
  stateRoot: string,
  config: import("./client-config").ClientConfig,
): Promise<void> {
  await writePrivateJson(join(stateRoot, "client-reload.json"), {
    configFingerprint: fingerprint(config),
    updatedAt: new Date().toISOString(),
  });
}

export async function waitForClientReload(
  store: import("./client-config").ClientConfigStore,
  stateRoot: string,
  expected: import("./client-config").ClientConfig,
  timeoutMs = 45_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const config = await store.read();
    if (fingerprint(config) !== fingerprint(expected))
      throw new Error("Configuration changed before Client reload completed");
    const state = await readReloadStateFile(join(stateRoot, "client-reload.json"));
    if (state?.configFingerprint === fingerprint(config)) return true;
    if (!(await processLockActive(join(stateRoot, "client.lock")))) return false;
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for Client Line and credential reload");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function readReloadStateFile(
  path: string,
): Promise<z.infer<typeof reloadStateSchema> | undefined> {
  try {
    return reloadStateSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
