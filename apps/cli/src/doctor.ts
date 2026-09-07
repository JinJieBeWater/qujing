import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { ConfigStore, type Config } from "./config";
import {
  assertPrivatePathEffect,
  assertPrivateTreeEffect,
  isPrivatePathEffect,
} from "./private-files";
import {
  doctorCheck,
  doctorMessage,
  portCheckEffect,
  promiseEffect,
  transportCheckEffect,
  type DoctorReport,
} from "./doctor-shared";
import { readTailcatStateEffect } from "./transport/supervisor";

export type { DoctorCheck, DoctorReport } from "./doctor-shared";
export { checkPortEffect } from "./doctor-shared";

interface DoctorPaths {
  configPath: string;
  stateRoot: string;
  transportBinary?: string;
}

interface DoctorDependencies {
  checkExecutable?: (binary: string) => Effect.Effect<boolean, unknown>;
  checkPort?: (host: string, port: number) => Effect.Effect<boolean, unknown>;
}

type Check = DoctorReport["checks"][number];
type ConfigResult = { config?: Config; check: Check };

export function runDoctorEffect(paths: DoctorPaths, dependencies: DoctorDependencies = {}) {
  const store = new ConfigStore(paths);
  return Effect.gen(function* () {
    const [configResult, permissions, transport, tailcat] = yield* Effect.all(
      [
        configCheckEffect(store),
        permissionsCheckEffect(paths, store),
        transportCheckEffect(paths.transportBinary),
        tailcatCheckEffect(paths.stateRoot),
      ],
      { concurrency: "unbounded" },
    );
    const configChecks = configResult.config
      ? yield* Effect.all(
          [
            runtimeCheckEffect(configResult.config, dependencies),
            workspaceChecksEffect(store, configResult.config),
            portCheckEffect(
              join(paths.stateRoot, "node.lock"),
              "Node",
              configResult.config.server,
              dependencies.checkPort,
            ),
          ],
          { concurrency: "unbounded" },
        )
      : undefined;
    const checks = [
      configResult.check,
      permissions,
      ...(configChecks ? [...configChecks[1], configChecks[2]] : []),
      transport,
      ...(configChecks ? [configChecks[0]] : []),
      tailcat,
    ];
    return {
      ok: checks.every((check) => check.status !== "error"),
      checks,
    } satisfies DoctorReport;
  });
}

function configCheckEffect(store: ConfigStore) {
  return store.readEffectiveEffect().pipe(
    Effect.map((config): ConfigResult => ({
      config,
      check: doctorCheck("config", "ok", "Node config is valid"),
    })),
    Effect.catchEager((error) =>
      Effect.succeed<ConfigResult>({
        check: doctorCheck("config", "error", doctorMessage(error, "Node config is invalid")),
      }),
    ),
  );
}

function permissionsCheckEffect(paths: DoctorPaths, store: ConfigStore) {
  return Effect.all(
    [
      assertPrivateTreeEffect(dirname(paths.configPath)),
      assertPrivatePathEffect(paths.configPath, false),
      assertPrivateTreeEffect(paths.stateRoot),
      assertPrivatePathEffect(store.tombstonesPath, false),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.as(doctorCheck("permissions", "ok", "Config and state permissions are private")),
    Effect.catchEager(() =>
      Effect.succeed(
        doctorCheck("permissions", "error", "Config and state permissions must be 0600/0700"),
      ),
    ),
  );
}

function workspaceChecksEffect(store: ConfigStore, config: Config) {
  return store.listPublicWorkspacesEffect().pipe(
    Effect.map((workspaces) => {
      const publicWorkspaces = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
      return config.workspaces.map((workspace) => {
        const available = publicWorkspaces.get(workspace.id)?.available === true;
        return doctorCheck(
          `workspace:${workspace.id}`,
          available ? "ok" : "error",
          available
            ? "Workspace root is canonical and readable"
            : "Workspace root is unavailable or non-canonical",
        );
      });
    }),
    Effect.catchEager(() =>
      Effect.succeed(
        config.workspaces.map((workspace) =>
          doctorCheck(
            `workspace:${workspace.id}`,
            "error",
            "Workspace root is unavailable or non-canonical",
          ),
        ),
      ),
    ),
  );
}

function runtimeCheckEffect(config: Config, dependencies: DoctorDependencies) {
  const runtime = config.runtime;
  if (runtime?.kind === "pi-rpc") {
    const executable = runtime.binary ?? "pi";
    return executableCheckEffect(executable, dependencies.checkExecutable).pipe(
      Effect.map((available) =>
        doctorCheck(
          "runtime",
          available ? "ok" : "error",
          available
            ? `Pi Runtime command is executable: ${executable} (${runtime.model})`
            : `Pi Runtime command is unavailable: ${executable} (${runtime.model})`,
        ),
      ),
      Effect.catchEager(() =>
        Effect.succeed(
          doctorCheck(
            "runtime",
            "error",
            `Pi Runtime command is unavailable: ${executable} (${runtime.model})`,
          ),
        ),
      ),
    );
  }
  if (runtime?.kind === "tanstack-acp") {
    const executable = firstExecutableToken(runtime.command);
    return (
      executable
        ? executableCheckEffect(executable, dependencies.checkExecutable)
        : Effect.succeed(false)
    ).pipe(
      Effect.map((available) =>
        doctorCheck(
          "runtime",
          available ? "ok" : "error",
          available
            ? `TanStack ACP Runtime command is executable: ${runtime.name}`
            : `TanStack ACP Runtime command is unavailable: ${runtime.name}`,
        ),
      ),
      Effect.catchEager(() =>
        Effect.succeed(
          doctorCheck(
            "runtime",
            "error",
            `TanStack ACP Runtime command is unavailable: ${runtime.name}`,
          ),
        ),
      ),
    );
  }
  return Effect.succeed(doctorCheck("runtime", "error", "Runtime is not configured"));
}

function executableCheckEffect(
  binary: string,
  checkExecutableOverride?: DoctorDependencies["checkExecutable"],
) {
  if (checkExecutableOverride) return checkExecutableOverride(binary);
  return promiseEffect(async () => {
    const resolved = Bun.which(binary);
    if (!resolved) return false;
    await access(resolved, constants.X_OK);
    return true;
  });
}

function firstExecutableToken(command: string): string | undefined {
  let index = 0;
  let afterEnv = false;
  for (;;) {
    const token = readShellToken(command, index);
    if (!token) return undefined;
    index = token.next;
    if (token.value === "env" && !afterEnv) {
      afterEnv = true;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value)) continue;
    if (afterEnv && token.value.startsWith("-")) continue;
    return token.value;
  }
}

function readShellToken(
  command: string,
  offset: number,
): { value: string; next: number } | undefined {
  let index = offset;
  while (index < command.length && /\s/.test(command[index]!)) index++;
  if (index >= command.length) return undefined;
  let value = "";
  let quote: "'" | '"' | undefined;
  while (index < command.length) {
    const char = command[index++]!;
    if (!quote && /\s/.test(char)) break;
    if (char === "\\") {
      if (index < command.length) value += command[index++]!;
      continue;
    }
    if (char === "'" || char === '"') {
      if (quote === char) quote = undefined;
      else if (!quote) quote = char;
      else value += char;
      continue;
    }
    value += char;
  }
  return { value, next: index };
}

function tailcatCheckEffect(stateRoot: string) {
  return readTailcatStateEffect(stateRoot).pipe(
    Effect.flatMap((tailcat) => {
      if (!tailcat)
        return Effect.succeed(
          doctorCheck("tailcat-state", "warning", "Tailcat Server has not completed first startup"),
        );
      const keyPath = join(stateRoot, "transport", "server-key.json");
      const statePath = join(stateRoot, "transport", "server.json");
      return Effect.all(
        [isPrivatePathEffect(statePath, false), isPrivatePathEffect(keyPath, false)],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map(([statePrivate, keyPrivate]) => statePrivate && keyPrivate),
        Effect.map((privateState) =>
          doctorCheck(
            "tailcat-state",
            privateState ? "ok" : "error",
            privateState
              ? "Tailcat Server key and address are persisted privately"
              : "Tailcat Server state or key permissions are unsafe",
          ),
        ),
      );
    }),
    Effect.catchEager((error) =>
      Effect.succeed(
        doctorCheck(
          "tailcat-state",
          "error",
          doctorMessage(error, "Tailcat Server state is invalid"),
        ),
      ),
    ),
  );
}
