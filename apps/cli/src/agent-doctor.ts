import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { AgentApplication } from "./agent-application";
import { AgentConfigStore, type AgentConfig } from "./agent-config";
import {
  doctorCheck,
  doctorMessage,
  promiseEffect,
  transportCheckEffect,
  type DoctorCheck,
  type DoctorReport,
} from "./doctor-shared";
import { checkPortEffect } from "./doctor";
import { PeerRuntime } from "./peer-runtime";
import { assertPrivateTreeEffect, isPrivatePathEffect } from "./private-files";
import { processLockActiveEffect } from "./process-lock";
import { startConnectorEffect } from "./transport/process";

interface AgentDoctorPaths {
  agentConfigPath: string;
  agentStateRoot: string;
  transportBinary?: string;
}

interface AgentDoctorDependencies {
  inspectPeers?: (
    config: AgentConfig,
  ) => Effect.Effect<Array<{ id: string; available: boolean }>, unknown>;
  checkPort?: (host: string, port: number) => Effect.Effect<boolean, unknown>;
}

type Check = DoctorCheck;

export function runAgentDoctorEffect(
  paths: AgentDoctorPaths,
  dependencies: AgentDoctorDependencies = {},
) {
  const store = new AgentConfigStore({ configPath: paths.agentConfigPath });
  return Effect.gen(function* () {
    const [configResult, state, transport] = yield* Effect.all(
      [
        configCheckEffect(store),
        stateCheckEffect(paths.agentStateRoot),
        transportCheckEffect(paths.transportBinary, "Transport unavailable"),
      ],
      { concurrency: "unbounded" },
    );
    if (!configResult.config)
      return {
        ok: false,
        checks: [configResult.check, state, transport],
      } satisfies DoctorReport;
    const config = configResult.config;
    const [peerKeys, port, peers] = yield* Effect.all(
      [
        peerKeyChecksEffect(config),
        portCheckEffect(paths.agentStateRoot, config, dependencies.checkPort),
        peersCheckEffect(store, config, paths.transportBinary, dependencies.inspectPeers),
      ],
      { concurrency: "unbounded" },
    );
    const checks = [configResult.check, state, transport, ...peerKeys, port, ...peers];
    return {
      ok: checks.every((check) => check.status !== "error"),
      checks,
    } satisfies DoctorReport;
  });
}

function configCheckEffect(store: AgentConfigStore) {
  return store.readEffect().pipe(
    Effect.map((config) => ({
      config,
      check: doctorCheck("config", "ok", "Agent config is valid and private"),
    })),
    Effect.catchEager((error) =>
      Effect.succeed<{ config?: AgentConfig; check: Check }>({
        check: doctorCheck("config", "error", doctorMessage(error, "Agent config is invalid")),
      }),
    ),
  );
}

function stateCheckEffect(stateRoot: string) {
  return promiseEffect(() => stat(stateRoot)).pipe(
    Effect.flatMap(() =>
      assertPrivateTreeEffect(stateRoot).pipe(
        Effect.as(doctorCheck("state", "ok", "Agent state permissions are private")),
        Effect.catchEager(() =>
          Effect.succeed(doctorCheck("state", "error", "Agent state must be 0600/0700")),
        ),
      ),
    ),
    Effect.catchEager((error) =>
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? Effect.succeed(
            doctorCheck("state", "warning", "Agent state is not created until first serve"),
          )
        : Effect.succeed(
            doctorCheck("state", "error", doctorMessage(error, "Agent state must be 0600/0700")),
          ),
    ),
  );
}

function peerKeyChecksEffect(config: AgentConfig) {
  return Effect.all(
    config.peers.map((peer) =>
      isPrivatePathEffect(peer.keyPath, false).pipe(
        Effect.map((privateKey) =>
          doctorCheck(
            `peer-key:${peer.id}`,
            privateKey ? "ok" : "error",
            privateKey ? "Peer key is private" : "Peer key is missing or unsafe",
          ),
        ),
        Effect.catchEager(() =>
          Effect.succeed(
            doctorCheck(`peer-key:${peer.id}`, "error", "Peer key is missing or unsafe"),
          ),
        ),
      ),
    ),
    { concurrency: "unbounded" },
  );
}

function portCheckEffect(
  stateRoot: string,
  config: AgentConfig,
  checkPortOverride?: AgentDoctorDependencies["checkPort"],
) {
  return processLockActiveEffect(join(stateRoot, "agent.lock")).pipe(
    Effect.flatMap((running) =>
      (running
        ? Effect.succeed<boolean>(true)
        : checkPortOverride
          ? checkPortOverride(config.server.host, config.server.port)
          : checkPortEffect(config.server.host, config.server.port)
      ).pipe(Effect.map((available) => ({ available, running }))),
    ),
    Effect.map(({ available, running }) =>
      doctorCheck(
        "port",
        available ? "ok" : "error",
        running
          ? "Agent is running"
          : available
            ? "Agent port is available"
            : "Agent port is already in use",
      ),
    ),
    Effect.catchEager(() =>
      Effect.succeed(doctorCheck("port", "error", "Agent port is already in use")),
    ),
  );
}

function peersCheckEffect(
  store: AgentConfigStore,
  config: AgentConfig,
  transportBinary: string | undefined,
  inspectPeersOverride?: AgentDoctorDependencies["inspectPeers"],
) {
  const peers = inspectPeersOverride
    ? inspectPeersOverride(config)
    : inspectPeersEffect(store, transportBinary);
  return peers.pipe(
    Effect.map((entries) =>
      entries.map((peer) =>
        doctorCheck(
          `peer:${peer.id}`,
          peer.available ? "ok" : "error",
          peer.available ? "Peer and Workspaces are reachable" : "Peer is unavailable",
        ),
      ),
    ),
    Effect.catchEager((error) =>
      Effect.succeed([doctorCheck("peers", "error", doctorMessage(error, "Peer checks failed"))]),
    ),
  );
}

function inspectPeersEffect(store: AgentConfigStore, transportBinary?: string) {
  return Effect.scoped(
    Effect.gen(function* () {
      const app = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new AgentApplication({
              config: store,
              createRuntime: (peer) =>
                new PeerRuntime({
                  peer,
                  startConnectorEffect: (connector, signal) =>
                    startConnectorEffect(connector, transportBinary, signal),
                }),
            }),
        ),
        (resource) => resource.closeEffect().pipe(Effect.catchEager(() => Effect.void)),
      );
      return yield* app
        .listPeersEffect(AbortSignal.timeout(15_000))
        .pipe(Effect.map((peers) => peers.map(({ id, available }) => ({ id, available }))));
    }),
  );
}
