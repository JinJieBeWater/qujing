import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { Duration, Effect } from "effect";
import { ConfigStore, type Config } from "./config";
import {
  assertPrivatePathEffect,
  assertPrivateTreeEffect,
  isPrivatePathEffect,
} from "./private-files";
import { processLockActiveEffect } from "./process-lock";
import { requireTransportBinaryEffect, transportBinaryPath } from "./transport/process";
import { readTailcatStateEffect } from "./transport/supervisor";

export interface DoctorCheck {
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
}

interface DoctorDependencies {
  checkPi?: (binary: string) => Effect.Effect<boolean, unknown>;
  checkPort?: (host: string, port: number) => Effect.Effect<boolean, unknown>;
}

type Check = DoctorReport["checks"][number];
type ConfigResult = { config?: Config; check: Check };

export function runDoctorEffect(paths: DoctorPaths, dependencies: DoctorDependencies = {}) {
  const store = new ConfigStore(paths);
  return Effect.gen(function* () {
    const [configResult, permissions, transport, pi, tailcat] = yield* Effect.all(
      [
        configCheckEffect(store),
        permissionsCheckEffect(paths, store),
        transportCheckEffect(paths.transportBinary),
        piCheckEffect("pi", dependencies.checkPi),
        tailcatCheckEffect(paths.stateRoot),
      ],
      { concurrency: "unbounded" },
    );
    const configChecks = configResult.config
      ? yield* Effect.all(
          [
            workspaceChecksEffect(store, configResult.config),
            portCheckEffect(paths.stateRoot, configResult.config, dependencies.checkPort),
          ],
          { concurrency: "unbounded" },
        )
      : undefined;
    const checks = [
      configResult.check,
      permissions,
      ...(configChecks ? [...configChecks[0], configChecks[1]] : []),
      transport,
      pi,
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
      check: check("config", "ok", "Owner config is valid"),
    })),
    Effect.catchEager((error) =>
      Effect.succeed<ConfigResult>({
        check: check("config", "error", message(error, "Owner config is invalid")),
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
    Effect.as(check("permissions", "ok", "Config and state permissions are private")),
    Effect.catchEager(() =>
      Effect.succeed(
        check("permissions", "error", "Config and state permissions must be 0600/0700"),
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
        return check(
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
          check(
            `workspace:${workspace.id}`,
            "error",
            "Workspace root is unavailable or non-canonical",
          ),
        ),
      ),
    ),
  );
}

function portCheckEffect(
  stateRoot: string,
  config: Config,
  checkPortOverride?: DoctorDependencies["checkPort"],
) {
  return processLockActiveEffect(join(stateRoot, "gateway.lock")).pipe(
    Effect.flatMap((running) =>
      (running
        ? Effect.succeed<boolean>(true)
        : portAvailableEffect(config.server.host, config.server.port, checkPortOverride)
      ).pipe(
        Effect.map((available) =>
          check(
            "port",
            available ? "ok" : "error",
            running
              ? "Gateway is running"
              : available
                ? "Gateway port is available"
                : "Gateway port is already in use",
          ),
        ),
      ),
    ),
    Effect.catchEager(() =>
      Effect.succeed(check("port", "error", "Gateway port is already in use")),
    ),
  );
}

function portAvailableEffect(
  host: string,
  port: number,
  checkPortOverride?: DoctorDependencies["checkPort"],
) {
  return checkPortOverride ? checkPortOverride(host, port) : checkPortEffect(host, port);
}

function transportCheckEffect(binaryPath?: string) {
  return requireTransportBinaryEffect(binaryPath ?? transportBinaryPath()).pipe(
    Effect.flatMap((binary) => promise(() => access(binary, constants.X_OK))),
    Effect.as(check("transport", "ok", "Tailcat transport binary is executable")),
    Effect.catchEager((error) =>
      Effect.succeed(
        check("transport", "error", message(error, "Tailcat transport binary is unavailable")),
      ),
    ),
  );
}

function piCheckEffect(binary: string, checkPiOverride?: DoctorDependencies["checkPi"]) {
  return (checkPiOverride ? checkPiOverride(binary) : checkPiEffect(binary)).pipe(
    Effect.map((available) =>
      check(
        "pi",
        available ? "ok" : "error",
        available ? "Global Pi CLI is executable" : "Global Pi CLI is unavailable",
      ),
    ),
    Effect.catchEager(() => Effect.succeed(check("pi", "error", "Global Pi CLI is unavailable"))),
  );
}

function tailcatCheckEffect(stateRoot: string) {
  return readTailcatStateEffect(stateRoot).pipe(
    Effect.flatMap((tailcat) => {
      if (!tailcat)
        return Effect.succeed(
          check("tailcat-state", "warning", "Tailcat Server has not completed first startup"),
        );
      const keyPath = join(stateRoot, "transport", "server-key.json");
      const statePath = join(stateRoot, "transport", "server.json");
      return Effect.all(
        [isPrivatePathEffect(statePath, false), isPrivatePathEffect(keyPath, false)],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map(([statePrivate, keyPrivate]) => statePrivate && keyPrivate),
        Effect.map((privateState) =>
          check(
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
        check("tailcat-state", "error", message(error, "Tailcat Server state is invalid")),
      ),
    ),
  );
}

function checkPiEffect(binary: string) {
  return Effect.scoped(
    Effect.gen(function* () {
      const child = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.spawn([binary, "--version"], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          }),
        ),
        (process) =>
          promise(async () => {
            if (process.exitCode === null) process.kill("SIGKILL");
            await process.exited;
          }).pipe(Effect.catchEager(() => Effect.void)),
      );
      return yield* promise(() => child.exited).pipe(
        Effect.map((code) => code === 0),
        Effect.timeoutOrElse({
          duration: Duration.seconds(5),
          orElse: () => Effect.succeed(false),
        }),
      );
    }),
  );
}

export function checkPortEffect(host: string, port: number) {
  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.sync(() => createServer()),
        (resource) =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) =>
                resource.listening ? resource.close(() => resolve()) : resolve(),
              ),
          ),
      );
      return yield* promise(
        () =>
          new Promise<boolean>((resolve) => {
            server.once("error", () => resolve(false));
            server.listen(port, host, () => resolve(true));
          }),
      );
    }),
  );
}

function promise<A>(try_: () => Promise<A>) {
  return Effect.tryPromise({ try: try_, catch: (error) => error });
}
function check(name: string, status: Check["status"], message: string): Check {
  return { name, status, message };
}
function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
