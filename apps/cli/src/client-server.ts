import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ClientApplication, type LineRuntimeClient } from "./client-application";
import { ClientConfigStore, type LineConfig, LOCAL_CLIENT_ID } from "./client-config";
import { processClientLineRetirement } from "./client-control";
import { createClientMcp } from "./client-mcp";
import { acknowledgeClientReload } from "./gateway-reload";
import { LineRuntime } from "./line-runtime";
import { assertPrivatePath, assertPrivateTree, ensurePrivateDirectory } from "./private-files";
import { acquireProcessLock } from "./process-lock";
import { createFatalHandler } from "./server";
import { startConnector } from "./transport/process";

export interface ClientServerOptions {
  configPath: string;
  stateRoot: string;
  fatal?: (error: Error) => void;
  fatalShutdownTimeoutMs?: number;
  port?: number;
  transportBinary?: string;
  createRuntime?: (line: LineConfig) => LineRuntimeClient;
}

export async function startClientServer(options: ClientServerOptions) {
  await assertPrivatePath(dirname(options.configPath), true);
  await assertPrivatePath(options.configPath, false);
  const stateExists = await stat(options.stateRoot).then(
    () => true,
    (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    },
  );
  if (stateExists) await assertPrivateTree(options.stateRoot);
  else await ensurePrivateDirectory(options.stateRoot);
  const releaseLock = await acquireProcessLock(
    join(options.stateRoot, "client.lock"),
    "Colleague Line Client is already running",
  );
  try {
    return await startLockedClientServer(options, releaseLock);
  } catch (error) {
    await releaseLock();
    throw error;
  }
}

async function startLockedClientServer(
  options: ClientServerOptions,
  releaseLock: () => Promise<void>,
) {
  const config = new ClientConfigStore({ configPath: options.configPath });
  let current = await config.read();
  const app = new ClientApplication({
    config,
    createRuntime:
      options.createRuntime ??
      ((line) =>
        new LineRuntime({
          line,
          startConnector: (connector, signal) =>
            startConnector(connector, options.transportBinary, signal),
        })),
  });
  await processClientLineRetirement(options.stateRoot, current, app);
  let closeResources = async () => {};
  const fatal = createFatalHandler(
    () => closeResources(),
    options.fatal ?? (() => process.exit(1)),
    options.fatalShutdownTimeoutMs,
  );
  const mcp = createClientMcp({
    app,
    config,
    allowedHosts: [current.server.host, "localhost"],
    allowedOrigins: [],
    fatal,
  });
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: current.server.host,
      port: options.port ?? current.server.port,
      idleTimeout: 255,
      fetch: (request) => mcp.fetch(request),
    });
  } catch (error) {
    await Promise.allSettled([mcp.close(), app.close()]);
    throw error;
  }
  let reloadTimer: ReturnType<typeof setInterval> | undefined;
  let reloading = Promise.resolve();
  let closePromise: Promise<void> | undefined;
  closeResources = () => {
    closePromise ??= (async () => {
      try {
        if (reloadTimer) clearInterval(reloadTimer);
        await reloading;
        let failure: unknown;
        for (const operation of [
          () => Promise.resolve(server.stop(true)),
          () => mcp.close(),
          () => app.close(),
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
    await acknowledgeClientReload(options.stateRoot, current);
  } catch (error) {
    try {
      await closeResources();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Client startup cleanup failed");
    }
    throw error;
  }
  reloadTimer = setInterval(() => {
    reloading = reloading
      .then(async () => {
        const next = await config.read();
        await processClientLineRetirement(options.stateRoot, next, app);
        const reconciled = await app.reconcile();
        if (reconciled.localBearerHash !== current.localBearerHash)
          await mcp.closeClient(LOCAL_CLIENT_ID);
        current = reconciled;
        await acknowledgeClientReload(options.stateRoot, current);
      })
      .catch((error) => fatal(error instanceof Error ? error : new Error("Client reload failed")));
  }, 250);
  reloadTimer.unref?.();
  return {
    url: `http://${server.hostname}:${server.port}`,
    server,
    close: closeResources,
  };
}
