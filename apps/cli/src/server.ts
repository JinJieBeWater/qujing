import { dirname, join } from "node:path";
import { Duration, Effect, Exit, Fiber, Ref, Scope } from "effect";
import { pollEvery } from "./effect-runtime";
import { createQujing } from "./qujing";
import { ConfigStore, type Config } from "./config";
import { acknowledgeGatewayReloadEffect, configFingerprint } from "./gateway-reload";
import { createMcpGateway } from "./mcp";
import { assertPrivatePathEffect, assertPrivateTreeEffect } from "./private-files";
import { acquireGatewayLockEffect } from "./process-lock";
import { RuntimeCoordinator } from "./runtime/coordinator";
import { PiRuntime } from "./runtime/pi-runtime";
import { RuntimeSessionStore } from "./runtime/sessions";
import { TailcatSupervisor } from "./transport/supervisor";

interface ServerOptions {
  configPath: string;
  stateRoot: string;
  transportBinary?: string;
  fatal?: (error: Error) => void;
  fatalShutdownTimeoutMs?: number;
}

interface StartedServer {
  url: string;
  tailcat: import("./schemas").TailcatState;
  server: ReturnType<typeof Bun.serve>;
}

/** Root gateway program. Acquisition order makes close: poll, transport, Bun, MCP, runtime, lock. */
export function startServerEffect(paths: ServerOptions, scope: Scope.Scope) {
  return Effect.gen(function* () {
    yield* assertPrivateTreeEffect(dirname(paths.configPath));
    yield* assertPrivatePathEffect(paths.configPath, false);
    yield* assertPrivateTreeEffect(paths.stateRoot);
    yield* assertPrivatePathEffect(join(paths.stateRoot, "tombstones.json"), false);
    yield* Effect.acquireRelease(acquireGatewayLockEffect(paths.stateRoot), (release) =>
      release.pipe(Effect.orDie),
    );

    const config = new ConfigStore(paths);
    const current = yield* Ref.make<Config>(yield* config.readEffectiveEffect());
    const effective = yield* Ref.get(current);
    const sessions = new RuntimeSessionStore(paths.stateRoot);
    const fatal = createScopedFatalHandler(
      scope,
      paths.fatal ?? (() => process.exit(1)),
      paths.fatalShutdownTimeoutMs,
    );
    const runtime = yield* PiRuntime.createEffect({ fatal });
    const resources = yield* Effect.acquireRelease(
      RuntimeCoordinator.createEffect({
        config,
        sessions,
        runtime,
        desired: yield* Ref.get(current),
      }).pipe(
        Effect.map((coordinator) => ({
          coordinator,
          gateway: createMcpGateway({
            app: createQujing({ config, coordinator }),
            authenticateEffect: (bearer) => config.authenticateEffect(bearer),
            allowedHosts: [effective.server.host, "localhost"],
            allowedOrigins: [],
            fatal,
          }),
        })),
      ),
      ({ coordinator, gateway }) =>
        gateway.closeEffect.pipe(
          Effect.ensuring(coordinator.closeEffect().pipe(Effect.orDie)),
          Effect.orDie,
        ),
    );
    const { coordinator, gateway } = resources;
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => {
        return Bun.serve({
          hostname: effective.server.host,
          port: effective.server.port,
          idleTimeout: 255,
          fetch: (request) => gateway.fetch(request),
        });
      }),
      (resource) => Effect.sync(() => resource.stop(true)),
    );
    const transport = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new TailcatSupervisor({
            stateRoot: paths.stateRoot,
            port: server.port ?? effective.server.port,
            ...(paths.transportBinary === undefined ? {} : { binary: paths.transportBinary }),
            onFatal: fatal,
          }),
      ),
      (resource) => resource.closeEffect().pipe(Effect.orDie),
    );

    const initial = yield* Ref.get(current);
    yield* transport.reloadEffect(initial.clients.map((client) => client.tailcatKey));
    yield* acknowledgeGatewayReloadEffect(paths.stateRoot, initial);
    yield* startReloadFiber(
      config,
      current,
      coordinator,
      gateway,
      transport,
      paths.stateRoot,
      fatal,
    );

    return {
      url: `http://${server.hostname}:${server.port}`,
      tailcat: yield* transport.stateEffect(),
      server,
    } satisfies StartedServer;
  });
}

function startReloadFiber(
  config: ConfigStore,
  current: Ref.Ref<Config>,
  coordinator: RuntimeCoordinator,
  gateway: ReturnType<typeof createMcpGateway>,
  transport: TailcatSupervisor,
  stateRoot: string,
  fatal: (error: Error) => void,
) {
  const reload = Effect.gen(function* () {
    const previous = yield* Ref.get(current);
    const next = yield* config.readEffectiveEffect();
    if (configFingerprint(next) === configFingerprint(previous)) return;
    yield* Effect.all(
      [
        coordinator.reconcileEffect(next),
        ...changedClientIds(previous, next).map((clientId) => gateway.closeClientEffect(clientId)),
      ],
      { concurrency: "unbounded" },
    );
    yield* transport.reloadEffect(next.clients.map((client) => client.tailcatKey));
    yield* Ref.set(current, next);
    yield* acknowledgeGatewayReloadEffect(stateRoot, next);
  }).pipe(
    Effect.catchEager((error) =>
      Effect.sync(() => fatal(error instanceof Error ? error : new Error("Config reload failed"))),
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

export function createScopedFatalHandler(
  scope: Scope.Scope,
  terminate: (error: Error) => void,
  timeoutMs = 10_000,
): (error: Error) => void {
  let triggered = false;
  return (error) => {
    if (triggered) return;
    triggered = true;
    void Effect.runPromise(
      Scope.close(scope, Exit.void).pipe(
        Effect.timeout(Duration.millis(timeoutMs)),
        Effect.asVoid,
        Effect.catchEager(() => Effect.void),
        Effect.ensuring(Effect.sync(() => terminate(error))),
      ),
    );
  };
}

function changedClientIds(previous: Config, next: Config): string[] {
  const current = new Map(
    next.clients.map((client) => [client.id, `${client.tailcatKey}\0${client.bearerHash}`]),
  );
  return previous.clients
    .filter((client) => current.get(client.id) !== `${client.tailcatKey}\0${client.bearerHash}`)
    .map((client) => client.id);
}
