import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { ConfigStore, type Config } from "./config";
import { assertPrivatePath, assertPrivateTree, isPrivatePath } from "./private-files";
import { processLockActive } from "./process-lock";
import { readTailcatState } from "./transport/supervisor";
import { requireTransportBinary, transportBinaryPath } from "./transport/process";
import { piBinaryPath } from "./runtime/pi-rpc";

interface DoctorCheck {
  name: string;
  status: "ok" | "warning" | "error";
  message: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

interface DoctorPaths {
  configPath: string;
  stateRoot: string;
  transportBinary?: string;
  piBinary?: string;
}

interface DoctorDependencies {
  checkPi?: (binary: string) => Promise<boolean>;
  checkPort?: (host: string, port: number) => Promise<boolean>;
}

export async function runDoctor(
  paths: DoctorPaths,
  dependencies: DoctorDependencies = {},
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = (name: string, status: DoctorCheck["status"], message: string) =>
    checks.push({ name, status, message });
  const store = new ConfigStore(paths);
  let config: Config | undefined;
  try {
    config = await store.readEffective();
    add("config", "ok", "Owner config is valid");
  } catch (error) {
    add("config", "error", error instanceof Error ? error.message : "Owner config is invalid");
  }

  if (config) {
    const safe = await Promise.all([
      assertPrivateTree(dirname(paths.configPath)),
      assertPrivatePath(paths.configPath, false),
      assertPrivateTree(paths.stateRoot),
      assertPrivatePath(store.tombstonesPath, false),
    ]).then(
      () => true,
      () => false,
    );
    add(
      "permissions",
      safe ? "ok" : "error",
      safe
        ? "Config and state permissions are private"
        : "Config and state permissions must be 0600/0700",
    );

    const publicWorkspaces = new Map(
      (await store.listPublicWorkspaces()).map((workspace) => [workspace.id, workspace]),
    );
    for (const workspace of config.workspaces) {
      const available = publicWorkspaces.get(workspace.id)?.available === true;
      add(
        `workspace:${workspace.id}`,
        available ? "ok" : "error",
        available
          ? "Workspace root is canonical and readable"
          : "Workspace root is unavailable or non-canonical",
      );
    }

    const running = await processLockActive(join(paths.stateRoot, "gateway.lock"));
    const portAvailable =
      running ||
      (await (dependencies.checkPort ?? checkPort)(config.server.host, config.server.port));
    add(
      "port",
      portAvailable ? "ok" : "error",
      running
        ? "Gateway is running"
        : portAvailable
          ? "Gateway port is available"
          : "Gateway port is already in use",
    );
  }

  try {
    const binary = await requireTransportBinary(paths.transportBinary ?? transportBinaryPath());
    await access(binary, constants.X_OK);
    add("transport", "ok", "Tailcat transport binary is executable");
  } catch (error) {
    add(
      "transport",
      "error",
      error instanceof Error ? error.message : "Tailcat transport binary is unavailable",
    );
  }

  const piAvailable = await (dependencies.checkPi ?? checkPi)(
    paths.piBinary ?? piBinaryPath(),
  ).catch(() => false);
  add(
    "pi",
    piAvailable ? "ok" : "error",
    piAvailable ? "Global Pi CLI is executable" : "Global Pi CLI is unavailable",
  );

  try {
    const tailcat = await readTailcatState(paths.stateRoot);
    if (!tailcat) add("tailcat-state", "warning", "Tailcat Server has not completed first startup");
    else {
      const keyPath = join(paths.stateRoot, "transport", "server-key.json");
      const statePath = join(paths.stateRoot, "transport", "server.json");
      const privateState =
        (await isPrivatePath(statePath, false)) && (await isPrivatePath(keyPath, false));
      add(
        "tailcat-state",
        privateState ? "ok" : "error",
        privateState
          ? "Tailcat Server key and address are persisted privately"
          : "Tailcat Server state or key permissions are unsafe",
      );
    }
  } catch (error) {
    add(
      "tailcat-state",
      "error",
      error instanceof Error ? error.message : "Tailcat Server state is invalid",
    );
  }

  return { ok: checks.every((check) => check.status !== "error"), checks };
}

async function checkPi(binary: string): Promise<boolean> {
  const child = Bun.spawn([binary, "--version"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const available = await Promise.race([
    child.exited.then((code) => code === 0),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), 5_000);
    }),
  ]);
  clearTimeout(timer);
  if (!available && child.exitCode === null) {
    child.kill("SIGKILL");
    await child.exited;
  }
  return available;
}

function checkPort(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}
