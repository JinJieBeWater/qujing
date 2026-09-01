import { dirname, join } from "node:path";
import { createColleagueLine } from "./colleague-line";
import { ConfigStore } from "./config";
import { createMcpGateway } from "./mcp";
import { acknowledgeGatewayReload } from "./gateway-reload";
import { defaultPaths } from "./paths";
import { assertPrivatePath, assertPrivateTree } from "./private-files";
import { acquireGatewayLock } from "./process-lock";
import { RuntimeCoordinator } from "./runtime/coordinator";
import { PiRuntime } from "./runtime/pi-runtime";
import { RuntimeSessionStore } from "./runtime/sessions";
import { TailcatSupervisor } from "./transport/supervisor";

interface ServerOptions {
  configPath: string;
  stateRoot: string;
  transportBinary?: string;
  piBinary?: string;
  fatal?: (error: Error) => void;
  fatalShutdownTimeoutMs?: number;
}

export async function startServer(paths: ServerOptions = defaultPaths()) {
  await assertPrivateTree(dirname(paths.configPath));
  await assertPrivatePath(paths.configPath, false);
  await assertPrivateTree(paths.stateRoot);
  await assertPrivatePath(join(paths.stateRoot, "tombstones.json"), false);
  const releaseLock = await acquireGatewayLock(paths.stateRoot);
  try {
    return await startLockedServer(paths, releaseLock);
  } catch (error) {
    await releaseLock();
    throw error;
  }
}

async function startLockedServer(paths: ServerOptions, releaseLock: () => Promise<void>) {
  const config = new ConfigStore(paths);
  let current = await config.readEffective();
  const sessions = new RuntimeSessionStore(paths.stateRoot);
  let closeResources = async () => {};
  const fatal = createFatalHandler(
    () => closeResources(),
    paths.fatal ?? (() => process.exit(1)),
    paths.fatalShutdownTimeoutMs,
  );
  const runtime = await PiRuntime.create({
    ...(paths.piBinary === undefined ? {} : { piBinary: paths.piBinary }),
    fatal,
  });
  const coordinator = await RuntimeCoordinator.create({
    config,
    sessions,
    runtime,
    desired: current,
  });
  const app = createColleagueLine({
    config,
    answer: (input) => coordinator.answer(input),
  });
  const gateway = createMcpGateway({
    app,
    authenticate: (bearer) => config.authenticate(bearer),
    allowedHosts: [current.server.host, "localhost"],
    allowedOrigins: [],
    fatal,
  });
  const server = Bun.serve({
    hostname: current.server.host,
    port: current.server.port,
    idleTimeout: 255,
    fetch: (request) => gateway.fetch(request),
  });
  const transport = new TailcatSupervisor({
    stateRoot: paths.stateRoot,
    port: current.server.port,
    ...(paths.transportBinary === undefined ? {} : { binary: paths.transportBinary }),
    onFatal: fatal,
  });
  let reloading = Promise.resolve();
  let reloadTimer: ReturnType<typeof setInterval> | undefined;
  let closePromise: Promise<void> | undefined;
  closeResources = () => {
    closePromise ??= (async () => {
      try {
        if (reloadTimer) clearInterval(reloadTimer);
        await reloading;
        let failure: unknown;
        for (const operation of [
          () => transport.close(),
          () => Promise.resolve(server.stop(true)),
          () => coordinator.close(),
          () => gateway.close(),
        ]) {
          try {
            await operation();
          } catch (error) {
            failure ??= error;
          }
        }
        if (failure) throw failure;
      } finally {
        await releaseLock();
      }
    })();
    return closePromise;
  };
  try {
    await transport.reload(current.clients.map((client) => client.tailcatKey));
    await acknowledgeGatewayReload(paths.stateRoot, current);
  } catch (error) {
    try {
      await closeResources();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Gateway startup cleanup failed");
    }
    throw error;
  }
  reloadTimer = setInterval(() => {
    reloading = reloading
      .then(async () => {
        const next = await config.readEffective();
        await Promise.all([
          coordinator.reconcile(next),
          ...changedClientIds(current, next).map((clientId) => gateway.closeClient(clientId)),
        ]);
        await transport.reload(next.clients.map((client) => client.tailcatKey));
        current = next;
        await acknowledgeGatewayReload(paths.stateRoot, current);
      })
      .catch((error) => fatal(error instanceof Error ? error : new Error("Config reload failed")));
  }, 250);
  reloadTimer.unref?.();
  const tailcat = await transport.state();
  return {
    url: `http://${server.hostname}:${server.port}`,
    tailcat,
    server,
    close: closeResources,
  };
}

export function createFatalHandler(
  close: () => Promise<void>,
  terminate: (error: Error) => void,
  timeoutMs = 10_000,
): (error: Error) => void {
  let triggered = false;
  return (error) => {
    if (triggered) return;
    triggered = true;
    void settleWithin(close(), timeoutMs).then(
      () => terminate(error),
      () => terminate(error),
    );
  };
}

async function settleWithin(operation: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function changedClientIds(
  previous: Awaited<ReturnType<ConfigStore["read"]>>,
  next: Awaited<ReturnType<ConfigStore["read"]>>,
): string[] {
  const current = new Map(
    next.clients.map((client) => [client.id, `${client.tailcatKey}\0${client.bearerHash}`]),
  );
  return previous.clients
    .filter((client) => current.get(client.id) !== `${client.tailcatKey}\0${client.bearerHash}`)
    .map((client) => client.id);
}
