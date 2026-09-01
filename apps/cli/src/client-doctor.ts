import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { ClientApplication } from "./client-application";
import { ClientConfigStore, type ClientConfig } from "./client-config";
import type { DoctorReport } from "./doctor";
import { LineRuntime } from "./line-runtime";
import { assertPrivateTree, isPrivatePath } from "./private-files";
import { processLockActive } from "./process-lock";
import { requireTransportBinary, startConnector, transportBinaryPath } from "./transport/process";

interface ClientDoctorPaths {
  clientConfigPath: string;
  clientStateRoot: string;
  transportBinary?: string;
}

interface ClientDoctorDependencies {
  inspectLines?: (config: ClientConfig) => Promise<Array<{ id: string; available: boolean }>>;
  checkPort?: (host: string, port: number) => Promise<boolean>;
}

export async function runClientDoctor(
  paths: ClientDoctorPaths,
  dependencies: ClientDoctorDependencies = {},
): Promise<DoctorReport> {
  const checks: DoctorReport["checks"] = [];
  const add = (name: string, status: "ok" | "warning" | "error", message: string) =>
    checks.push({ name, status, message });
  const store = new ClientConfigStore({ configPath: paths.clientConfigPath });
  let config: ClientConfig;
  try {
    config = await store.read();
    add("config", "ok", "Client config is valid and private");
  } catch (error) {
    add("config", "error", error instanceof Error ? error.message : "Client config is invalid");
    return { ok: false, checks };
  }
  const stateExists = await stat(paths.clientStateRoot).then(
    () => true,
    (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    },
  );
  if (!stateExists) add("state", "warning", "Client state is not created until first serve");
  else {
    const privateState = await assertPrivateTree(paths.clientStateRoot).then(
      () => true,
      () => false,
    );
    add(
      "state",
      privateState ? "ok" : "error",
      privateState ? "Client state permissions are private" : "Client state must be 0600/0700",
    );
  }
  try {
    const binary = await requireTransportBinary(paths.transportBinary ?? transportBinaryPath());
    await access(binary, constants.X_OK);
    add("transport", "ok", "Tailcat transport binary is executable");
  } catch (error) {
    add("transport", "error", error instanceof Error ? error.message : "Transport unavailable");
  }
  for (const line of config.lines) {
    const privateKey = await isPrivatePath(line.keyPath, false);
    add(
      `line-key:${line.id}`,
      privateKey ? "ok" : "error",
      privateKey ? "Line key is private" : "Line key is missing or unsafe",
    );
  }
  const running = await processLockActive(join(paths.clientStateRoot, "client.lock"));
  const portAvailable =
    running ||
    (await (dependencies.checkPort ?? checkPort)(config.server.host, config.server.port));
  add(
    "port",
    portAvailable ? "ok" : "error",
    running
      ? "Client is running"
      : portAvailable
        ? "Client port is available"
        : "Client port is already in use",
  );
  try {
    const lines = dependencies.inspectLines
      ? await dependencies.inspectLines(config)
      : await inspectLines(store, paths.transportBinary);
    for (const line of lines) {
      add(
        `line:${line.id}`,
        line.available ? "ok" : "error",
        line.available ? "Owner and Workspaces are reachable" : "Line is unavailable",
      );
    }
  } catch (error) {
    add("lines", "error", error instanceof Error ? error.message : "Line checks failed");
  }
  return { ok: checks.every((check) => check.status !== "error"), checks };
}

async function inspectLines(
  store: ClientConfigStore,
  transportBinary?: string,
): Promise<Array<{ id: string; available: boolean }>> {
  const app = new ClientApplication({
    config: store,
    createRuntime: (line) =>
      new LineRuntime({
        line,
        startConnector: (connector, signal) => startConnector(connector, transportBinary, signal),
      }),
  });
  try {
    return await app.listLines(AbortSignal.timeout(15_000));
  } finally {
    await app.close();
  }
}

function checkPort(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}
