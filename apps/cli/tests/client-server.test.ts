import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LineRuntimeClient } from "../src/client-application";
import { ClientConfigStore } from "../src/client-config";
import { runCli } from "../src/cli";
import { startClientServer } from "../src/client-server";

const roots: string[] = [];
const running: Array<Awaited<ReturnType<typeof startClientServer>>> = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "colleague-line-client-server-"));
  roots.push(root);
  const configPath = join(root, "config", "client.json");
  const stateRoot = join(root, "state");
  const store = new ClientConfigStore({ configPath });
  const initialized = await store.init();
  if (!initialized.initialized) throw new Error("Client did not initialize");
  const server = await startClientServer({ configPath, stateRoot, port: 0 });
  running.push(server);
  return { store, server, configPath, stateRoot, bearer: initialized.bearer };
}

async function connect(url: string, bearer: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
  });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(transport as Parameters<Client["connect"]>[0]);
  return client;
}

test("runs one local MCP endpoint and applies local token rotation", async () => {
  const { store, server, bearer } = await fixture();
  const first = await connect(server.url, bearer);
  expect((await first.listTools()).tools.map(({ name }) => name)).toEqual(["list_lines", "ask"]);

  const rotated = await store.rotateLocalBearer();
  await Bun.sleep(350);
  await expect(first.listTools()).rejects.toBeDefined();
  await first.close().catch(() => {});

  const second = await connect(server.url, rotated.bearer);
  expect((await second.listTools()).tools.map(({ name }) => name)).toEqual(["list_lines", "ask"]);
  await second.close();
});

test("holds one Client process lock and releases it on close", async () => {
  const { server, configPath, stateRoot } = await fixture();
  await expect(startClientServer({ configPath, stateRoot, port: 0 })).rejects.toThrow(
    "already running",
  );
  await server.close();
  running.splice(running.indexOf(server), 1);

  const restarted = await startClientServer({ configPath, stateRoot, port: 0 });
  running.push(restarted);
  expect(await fetch(`${restarted.url}/healthz`).then((response) => response.json())).toEqual({
    status: "ok",
  });
});

test("rejects unsafe Client state before acquiring process lock", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "colleague-line-client-server-unsafe-"));
  roots.push(root);
  const configPath = join(root, "config", "client.json");
  const stateRoot = join(root, "state");
  await new ClientConfigStore({ configPath }).init();
  await Bun.write(join(stateRoot, "entry"), "state");
  await chmod(stateRoot, 0o755);

  await expect(startClientServer({ configPath, stateRoot, port: 0 })).rejects.toThrow(
    "Private state permissions",
  );
  expect(await Bun.file(join(stateRoot, "client.lock", "owner.json")).exists()).toBe(false);
});

test("retires active Line before CLI credential update commits", async () => {
  const root = await mkdtemp(join(tmpdir(), "colleague-line-client-rotation-"));
  roots.push(root);
  const configPath = join(root, "config", "client.json");
  const stateRoot = join(root, "state");
  const oldKey = join(root, "keys", "old.json");
  const newKey = join(root, "keys", "new.json");
  await mkdir(join(root, "keys"), { recursive: true });
  await Promise.all([Bun.write(oldKey, "old-key"), Bun.write(newKey, "new-key")]);
  await Promise.all([chmod(oldKey, 0o600), chmod(newKey, 0o600)]);
  const store = new ClientConfigStore({ configPath });
  const initialized = await store.init();
  if (!initialized.initialized) throw new Error("Client did not initialize");
  await store.add({
    id: "owner",
    expectedOwnerId: "owner",
    remoteClientId: "remote",
    serverAddress: "private",
    remotePort: 1,
    keyPath: oldKey,
    remoteBearer: "old-bearer",
  });

  let started!: () => void;
  const active = new Promise<void>((resolve) => {
    started = resolve;
  });
  let settled = false;
  let closed = false;
  const server = await startClientServer({
    configPath,
    stateRoot,
    port: 0,
    createRuntime: () =>
      ({
        listWorkspaces: async () => ({
          owner: { id: "owner", name: "Owner" },
          workspaces: [{ id: "docs", name: "Docs", summary: "Docs", available: true }],
        }),
        ask: async (_workspace, _question, signal) => {
          started();
          return new Promise((_resolve, reject) =>
            signal?.addEventListener(
              "abort",
              async () => {
                await Bun.sleep(20);
                settled = true;
                reject(signal.reason);
              },
              { once: true },
            ),
          );
        },
        close: async () => {
          closed = true;
        },
      }) satisfies LineRuntimeClient,
  });
  running.push(server);
  const client = await connect(server.url, initialized.bearer);
  const pending = client.callTool({
    name: "ask",
    arguments: { line: "owner", workspace: "docs", question: "wait" },
  });
  await active;

  const result = runCli(
    ["client", "line", "update", "owner", "--key", newKey, "--bearer", "-", "--yes"],
    {
      configPath: join(root, "unused-gateway.json"),
      stateRoot: join(root, "unused-gateway-state"),
      clientConfigPath: configPath,
      clientStateRoot: stateRoot,
      writeOut: () => {},
      writeError: () => {},
      readStdin: async () => "new-bearer",
      verifyLine: async () => {},
      gatewayReloadTimeoutMs: 2_000,
    },
  );
  for (let attempt = 0; (await store.get("owner"))?.remoteBearer === "old-bearer"; attempt++) {
    if (attempt > 100) throw new Error("credential update did not commit");
    await Bun.sleep(10);
  }
  expect({ settled, closed }).toEqual({ settled: true, closed: true });
  expect(await result).toBe(0);
  expect(await pending).toMatchObject({ isError: true });
  await client.close();
});
