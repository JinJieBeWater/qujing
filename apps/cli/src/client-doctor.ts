import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { ClientApplication } from "./client-application";
import { ClientConfigStore, type ClientConfig } from "./client-config";
import { checkPortEffect, type DoctorCheck, type DoctorReport } from "./doctor";
import { LineRuntime } from "./line-runtime";
import { assertPrivateTreeEffect, isPrivatePathEffect } from "./private-files";
import { processLockActiveEffect } from "./process-lock";
import {
  requireTransportBinaryEffect,
  startConnectorEffect,
  transportBinaryPath,
} from "./transport/process";

interface ClientDoctorPaths {
  clientConfigPath: string;
  clientStateRoot: string;
  transportBinary?: string;
}

interface ClientDoctorDependencies {
  inspectLines?: (
    config: ClientConfig,
  ) => Effect.Effect<Array<{ id: string; available: boolean }>, unknown>;
  checkPort?: (host: string, port: number) => Effect.Effect<boolean, unknown>;
}

type Check = DoctorCheck;

export function runClientDoctorEffect(
  paths: ClientDoctorPaths,
  dependencies: ClientDoctorDependencies = {},
) {
  const store = new ClientConfigStore({ configPath: paths.clientConfigPath });
  return Effect.gen(function* () {
    const [configResult, state, transport] = yield* Effect.all(
      [
        configCheckEffect(store),
        stateCheckEffect(paths.clientStateRoot),
        transportCheckEffect(paths.transportBinary),
      ],
      { concurrency: "unbounded" },
    );
    if (!configResult.config)
      return {
        ok: false,
        checks: [configResult.check, state, transport],
      } satisfies DoctorReport;
    const config = configResult.config;
    const [lineKeys, port, lines] = yield* Effect.all(
      [
        lineKeyChecksEffect(config),
        portCheckEffect(paths.clientStateRoot, config, dependencies.checkPort),
        linesCheckEffect(store, config, paths.transportBinary, dependencies.inspectLines),
      ],
      { concurrency: "unbounded" },
    );
    const checks = [configResult.check, state, transport, ...lineKeys, port, ...lines];
    return {
      ok: checks.every((check) => check.status !== "error"),
      checks,
    } satisfies DoctorReport;
  });
}

function configCheckEffect(store: ClientConfigStore) {
  return store.readEffect().pipe(
    Effect.map((config) => ({
      config,
      check: check("config", "ok", "Client config is valid and private"),
    })),
    Effect.catchEager((error) =>
      Effect.succeed<{ config?: ClientConfig; check: Check }>({
        check: check("config", "error", message(error, "Client config is invalid")),
      }),
    ),
  );
}

function stateCheckEffect(stateRoot: string) {
  return promise(() => stat(stateRoot)).pipe(
    Effect.flatMap(() =>
      assertPrivateTreeEffect(stateRoot).pipe(
        Effect.as(check("state", "ok", "Client state permissions are private")),
        Effect.catchEager(() =>
          Effect.succeed(check("state", "error", "Client state must be 0600/0700")),
        ),
      ),
    ),
    Effect.catchEager((error) =>
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? Effect.succeed(check("state", "warning", "Client state is not created until first serve"))
        : Effect.succeed(check("state", "error", message(error, "Client state must be 0600/0700"))),
    ),
  );
}

function transportCheckEffect(binaryPath?: string) {
  return requireTransportBinaryEffect(binaryPath ?? transportBinaryPath()).pipe(
    Effect.flatMap((binary) => promise(() => access(binary, constants.X_OK))),
    Effect.as(check("transport", "ok", "Tailcat transport binary is executable")),
    Effect.catchEager((error) =>
      Effect.succeed(check("transport", "error", message(error, "Transport unavailable"))),
    ),
  );
}

function lineKeyChecksEffect(config: ClientConfig) {
  return Effect.all(
    config.lines.map((line) =>
      isPrivatePathEffect(line.keyPath, false).pipe(
        Effect.map((privateKey) =>
          check(
            `line-key:${line.id}`,
            privateKey ? "ok" : "error",
            privateKey ? "Line key is private" : "Line key is missing or unsafe",
          ),
        ),
        Effect.catchEager(() =>
          Effect.succeed(check(`line-key:${line.id}`, "error", "Line key is missing or unsafe")),
        ),
      ),
    ),
    { concurrency: "unbounded" },
  );
}

function portCheckEffect(
  stateRoot: string,
  config: ClientConfig,
  checkPortOverride?: ClientDoctorDependencies["checkPort"],
) {
  return processLockActiveEffect(join(stateRoot, "client.lock")).pipe(
    Effect.flatMap((running) =>
      (running
        ? Effect.succeed<boolean>(true)
        : checkPortOverride
          ? checkPortOverride(config.server.host, config.server.port)
          : checkPortEffect(config.server.host, config.server.port)
      ).pipe(Effect.map((available) => ({ available, running }))),
    ),
    Effect.map(({ available, running }) =>
      check(
        "port",
        available ? "ok" : "error",
        running
          ? "Client is running"
          : available
            ? "Client port is available"
            : "Client port is already in use",
      ),
    ),
    Effect.catchEager(() =>
      Effect.succeed(check("port", "error", "Client port is already in use")),
    ),
  );
}

function linesCheckEffect(
  store: ClientConfigStore,
  config: ClientConfig,
  transportBinary: string | undefined,
  inspectLinesOverride?: ClientDoctorDependencies["inspectLines"],
) {
  const lines = inspectLinesOverride
    ? inspectLinesOverride(config)
    : inspectLinesEffect(store, transportBinary);
  return lines.pipe(
    Effect.map((entries) =>
      entries.map((line) =>
        check(
          `line:${line.id}`,
          line.available ? "ok" : "error",
          line.available ? "Owner and Workspaces are reachable" : "Line is unavailable",
        ),
      ),
    ),
    Effect.catchEager((error) =>
      Effect.succeed([check("lines", "error", message(error, "Line checks failed"))]),
    ),
  );
}

function inspectLinesEffect(store: ClientConfigStore, transportBinary?: string) {
  return Effect.scoped(
    Effect.gen(function* () {
      const app = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new ClientApplication({
              config: store,
              createRuntime: (line) =>
                new LineRuntime({
                  line,
                  startConnectorEffect: (connector, signal) =>
                    startConnectorEffect(connector, transportBinary, signal),
                }),
            }),
        ),
        (resource) => resource.closeEffect().pipe(Effect.catchEager(() => Effect.void)),
      );
      return yield* app
        .listLinesEffect(AbortSignal.timeout(15_000))
        .pipe(Effect.map((lines) => lines.map(({ id, available }) => ({ id, available }))));
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
