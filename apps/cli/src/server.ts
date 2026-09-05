import { dirname, join } from "node:path";
import { Duration, Effect, Exit, Fiber, Ref, Scope } from "effect";
import { pollEvery } from "./effect-runtime";
import { createQujing } from "./qujing";
import { ConfigStore, type Config } from "./config";
import { acknowledgeNodeReloadEffect, configFingerprint } from "./reload";
import { createMcpNode } from "./mcp";
import { assertPrivatePathEffect, assertPrivateTreeEffect } from "./private-files";
import { acquireNodeLockEffect } from "./process-lock";
import { changedOrRemovedPeerCredentialIds, RuntimeCoordinator } from "./runtime/coordinator";
import { startManagedPiRpcSessionEffect } from "./runtime/pi-rpc";
import { RuntimePool } from "./runtime/runtime-pool";
import { RuntimeSessionStore } from "./runtime/sessions";
import { createTanStackAcpSessionFactory } from "./runtime/tanstack-acp";
import type { RuntimeNodeSession } from "./runtime/session";
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

/** Root node program. Acquisition order makes close: poll, transport, Bun, MCP, runtime, lock. */
export function startServerEffect(paths: ServerOptions, scope: Scope.Scope) {
  return Effect.gen(function* () {
    yield* assertPrivateTreeEffect(dirname(paths.configPath));
    yield* assertPrivatePathEffect(paths.configPath, false);
    yield* assertPrivateTreeEffect(paths.stateRoot);
    yield* assertPrivatePathEffect(join(paths.stateRoot, "tombstones.json"), false);
    yield* Effect.acquireRelease(acquireNodeLockEffect(paths.stateRoot), (release) =>
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
    const tanStackSession = createTanStackAcpSessionFactory({ stateRoot: paths.stateRoot });
    const runtime = yield* RuntimePool.createEffect({
      fatal,
      createSessionEffect: (workspace, session): Effect.Effect<RuntimeNodeSession, unknown> =>
        Ref.get(current).pipe(
          Effect.flatMap((effective) => {
            const runtime = effective.runtime;
            if (runtime?.kind === "pi-rpc") {
              return startManagedPiRpcSessionEffect({
                cwd: workspace.root,
                sessionId: session.id,
                model: runtime.model,
                ...(runtime.binary === undefined ? {} : { binary: runtime.binary }),
              });
            }
            if (runtime?.kind === "tanstack-acp")
              return tanStackSession(workspace, session, runtime);
            return Effect.fail(new Error("Runtime is not configured"));
          }),
        ),
    });
    const resources = yield* Effect.acquireRelease(
      RuntimeCoordinator.createEffect({
        config,
        sessions,
        runtime,
        desired: yield* Ref.get(current),
      }).pipe(
        Effect.map((coordinator) => ({
          coordinator,
          node: createMcpNode({
            app: createQujing({ config, coordinator }),
            authenticateEffect: (bearer) => config.authenticateEffect(bearer),
            allowedHosts: [effective.server.host, "localhost"],
            allowedOrigins: [],
            fatal,
          }),
        })),
      ),
      ({ coordinator, node }) =>
        node.closeEffect.pipe(
          Effect.ensuring(coordinator.closeEffect().pipe(Effect.orDie)),
          Effect.orDie,
        ),
    );
    const { coordinator, node } = resources;
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => {
        return Bun.serve({
          hostname: effective.server.host,
          port: effective.server.port,
          idleTimeout: 255,
          fetch: (request) => node.fetch(request),
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
    yield* transport.reloadEffect(initial.peers.map((agent) => agent.tailcatKey));
    yield* acknowledgeNodeReloadEffect(paths.stateRoot, initial);
    yield* startReloadFiber(config, current, coordinator, node, transport, paths.stateRoot, fatal);

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
  node: ReturnType<typeof createMcpNode>,
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
        ...changedOrRemovedPeerCredentialIds(previous, next).map((peerId) =>
          node.closeCredentialEffect(peerId),
        ),
      ],
      { concurrency: "unbounded" },
    );
    yield* transport.reloadEffect(next.peers.map((agent) => agent.tailcatKey));
    yield* Ref.set(current, next);
    yield* acknowledgeNodeReloadEffect(stateRoot, next);
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
