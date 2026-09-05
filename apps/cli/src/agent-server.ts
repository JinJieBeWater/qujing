import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Duration, Effect, Fiber, Ref, Scope } from "effect";
import { AgentApplication, type PeerRuntimeAgent } from "./agent-application";
import {
  AgentConfigStore,
  type AgentConfig,
  type PeerConfig,
  LOCAL_AGENT_ID,
} from "./agent-config";
import { processPeerRetirementEffect } from "./agent-control";
import { createAgentMcp } from "./agent-mcp";
import { pollEvery } from "./effect-runtime";
import { acknowledgeAgentReloadEffect, configFingerprint } from "./reload";
import { PeerRuntime } from "./peer-runtime";
import {
  assertPrivatePathEffect,
  assertPrivateTreeEffect,
  ensurePrivateDirectoryEffect,
} from "./private-files";
import { acquireProcessLockEffect } from "./process-lock";
import { createScopedFatalHandler } from "./server";
import { startConnectorEffect } from "./transport/process";

export interface AgentServerOptions {
  configPath: string;
  stateRoot: string;
  fatal?: (error: Error) => void;
  fatalShutdownTimeoutMs?: number;
  port?: number;
  transportBinary?: string;
  createRuntime?: (peer: PeerConfig) => PeerRuntimeAgent;
}

interface StartedAgentServer {
  url: string;
  server: ReturnType<typeof Bun.serve>;
}

/** Root Agent program. Acquisition order makes close: poll, Bun, MCP, app, lock. */
export function startAgentServerEffect(options: AgentServerOptions, scope: Scope.Scope) {
  return Effect.gen(function* () {
    yield* assertPrivatePathEffect(dirname(options.configPath), true);
    yield* assertPrivatePathEffect(options.configPath, false);
    const stateExists = yield* Effect.tryPromise({
      try: () =>
        stat(options.stateRoot).then(
          () => true,
          (error) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw error;
          },
        ),
      catch: (error) => error,
    });
    if (stateExists) yield* assertPrivateTreeEffect(options.stateRoot);
    else yield* ensurePrivateDirectoryEffect(options.stateRoot);
    yield* Effect.acquireRelease(
      acquireProcessLockEffect(
        join(options.stateRoot, "agent.lock"),
        "Qujing Agent is already running",
      ),
      (release) => release.pipe(Effect.orDie),
    );

    const config = new AgentConfigStore({ configPath: options.configPath });
    const initial = yield* config.readEffect();
    const current = yield* Ref.make<AgentConfig>(initial);
    const app = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new AgentApplication({
            config,
            createRuntime:
              options.createRuntime ??
              ((peer) =>
                new PeerRuntime({
                  peer,
                  startConnectorEffect: (connector, signal) =>
                    startConnectorEffect(connector, options.transportBinary, signal),
                })),
          }),
      ),
      (resource) => resource.closeEffect().pipe(Effect.orDie),
    );
    yield* processPeerRetirementEffect(options.stateRoot, initial, app);

    const fatal = createScopedFatalHandler(
      scope,
      options.fatal ?? (() => process.exit(1)),
      options.fatalShutdownTimeoutMs,
    );
    const effective = initial;
    const mcp = yield* Effect.acquireRelease(
      Effect.sync(() =>
        createAgentMcp({
          app,
          config,
          allowedHosts: [effective.server.host, "localhost"],
          allowedOrigins: [],
          fatal,
        }),
      ),
      (resource) => resource.closeEffect.pipe(Effect.orDie),
    );
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: effective.server.host,
          port: options.port ?? effective.server.port,
          idleTimeout: 255,
          fetch: (request) => mcp.fetch(request),
        }),
      ),
      (resource) => Effect.sync(() => resource.stop(true)),
    );

    yield* acknowledgeAgentReloadEffect(options.stateRoot, effective);
    yield* startReloadFiber(config, current, app, mcp, options.stateRoot, fatal);

    return {
      url: `http://${server.hostname}:${server.port}`,
      server,
    } satisfies StartedAgentServer;
  });
}

function startReloadFiber(
  config: AgentConfigStore,
  current: Ref.Ref<AgentConfig>,
  app: AgentApplication,
  mcp: ReturnType<typeof createAgentMcp>,
  stateRoot: string,
  fatal: (error: Error) => void,
) {
  const reload = Effect.gen(function* () {
    const previous = yield* Ref.get(current);
    const next = yield* config.readEffect();
    yield* processPeerRetirementEffect(stateRoot, next, app);
    if (configFingerprint(next) === configFingerprint(previous)) return;
    const reconciled = yield* app.reconcileEffect();
    if (reconciled.localBearerHash !== previous.localBearerHash)
      yield* mcp.closeCredentialEffect(LOCAL_AGENT_ID);
    yield* Ref.set(current, reconciled);
    yield* acknowledgeAgentReloadEffect(stateRoot, reconciled);
  }).pipe(
    Effect.catchEager((error) =>
      Effect.sync(() => fatal(error instanceof Error ? error : new Error("Agent reload failed"))),
    ),
  );
  return Effect.acquireRelease(
    Effect.sleep(Duration.millis(250)).pipe(
      Effect.andThen(reload),
      Effect.repeat(pollEvery(250)),
      Effect.forkScoped,
    ),
    (fiber) => Fiber.interrupt(fiber),
  );
}
