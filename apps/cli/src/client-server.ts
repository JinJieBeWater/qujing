import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Duration, Effect, Fiber, Ref, Scope } from "effect";
import { ClientApplication, type LineRuntimeClient } from "./client-application";
import {
  ClientConfigStore,
  type ClientConfig,
  type LineConfig,
  LOCAL_CLIENT_ID,
} from "./client-config";
import { processClientLineRetirementEffect } from "./client-control";
import { createClientMcp } from "./client-mcp";
import { pollEvery } from "./effect-runtime";
import { acknowledgeClientReloadEffect, configFingerprint } from "./gateway-reload";
import { LineRuntime } from "./line-runtime";
import {
  assertPrivatePathEffect,
  assertPrivateTreeEffect,
  ensurePrivateDirectoryEffect,
} from "./private-files";
import { acquireProcessLockEffect } from "./process-lock";
import { createScopedFatalHandler } from "./server";
import { startConnectorEffect } from "./transport/process";

export interface ClientServerOptions {
  configPath: string;
  stateRoot: string;
  fatal?: (error: Error) => void;
  fatalShutdownTimeoutMs?: number;
  port?: number;
  transportBinary?: string;
  createRuntime?: (line: LineConfig) => LineRuntimeClient;
}

interface StartedClientServer {
  url: string;
  server: ReturnType<typeof Bun.serve>;
}

/** Root Client program. Acquisition order makes close: poll, Bun, MCP, app, lock. */
export function startClientServerEffect(options: ClientServerOptions, scope: Scope.Scope) {
  return Effect.gen(function* () {
    yield* assertPrivatePathEffect(dirname(options.configPath), true);
    yield* assertPrivatePathEffect(options.configPath, false);
    const stateExists = yield* promise(() =>
      stat(options.stateRoot).then(
        () => true,
        (error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        },
      ),
    );
    if (stateExists) yield* assertPrivateTreeEffect(options.stateRoot);
    else yield* ensurePrivateDirectoryEffect(options.stateRoot);
    yield* Effect.acquireRelease(
      acquireProcessLockEffect(
        join(options.stateRoot, "client.lock"),
        "Colleague Line Client is already running",
      ),
      (release) => release.pipe(Effect.orDie),
    );

    const config = new ClientConfigStore({ configPath: options.configPath });
    const initial = yield* config.readEffect();
    const current = yield* Ref.make<ClientConfig>(initial);
    const app = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new ClientApplication({
            config,
            createRuntime:
              options.createRuntime ??
              ((line) =>
                new LineRuntime({
                  line,
                  startConnectorEffect: (connector, signal) =>
                    startConnectorEffect(connector, options.transportBinary, signal),
                })),
          }),
      ),
      (resource) => resource.closeEffect().pipe(Effect.orDie),
    );
    yield* processClientLineRetirementEffect(options.stateRoot, initial, app);

    const fatal = createScopedFatalHandler(
      scope,
      options.fatal ?? (() => process.exit(1)),
      options.fatalShutdownTimeoutMs,
    );
    const effective = initial;
    const mcp = yield* Effect.acquireRelease(
      Effect.sync(() =>
        createClientMcp({
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

    yield* acknowledgeClientReloadEffect(options.stateRoot, effective);
    yield* startReloadFiber(config, current, app, mcp, options.stateRoot, fatal);

    return {
      url: `http://${server.hostname}:${server.port}`,
      server,
    } satisfies StartedClientServer;
  });
}

function startReloadFiber(
  config: ClientConfigStore,
  current: Ref.Ref<ClientConfig>,
  app: ClientApplication,
  mcp: ReturnType<typeof createClientMcp>,
  stateRoot: string,
  fatal: (error: Error) => void,
) {
  const reload = Effect.gen(function* () {
    const previous = yield* Ref.get(current);
    const next = yield* config.readEffect();
    yield* processClientLineRetirementEffect(stateRoot, next, app);
    if (configFingerprint(next) === configFingerprint(previous)) return;
    const reconciled = yield* app.reconcileEffect();
    if (reconciled.localBearerHash !== previous.localBearerHash)
      yield* mcp.closeClientEffect(LOCAL_CLIENT_ID);
    yield* Ref.set(current, reconciled);
    yield* acknowledgeClientReloadEffect(stateRoot, reconciled);
  }).pipe(
    Effect.catchEager((error) =>
      Effect.sync(() => fatal(error instanceof Error ? error : new Error("Client reload failed"))),
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

function promise<A>(try_: () => Promise<A>) {
  return Effect.tryPromise({ try: try_, catch: (error) => error });
}
