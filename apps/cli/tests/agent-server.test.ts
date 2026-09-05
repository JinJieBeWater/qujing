import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, test } from "bun:test";
import { Context, Effect, Exit, Scope } from "effect";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PeerRuntimeAgent } from "../src/agent-application";
import { AgentConfigStore } from "../src/agent-config";
import { runCliEffect } from "../src/cli";
import { startAgentServerEffect } from "../src/agent-server";

const roots: string[] = [];
const running: Array<Awaited<ReturnType<typeof start>>> = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function start(options: Parameters<typeof startAgentServerEffect>[0]) {
  const scope = await Effect.runPromise(Scope.make("sequential"));
  const started = await Effect.runPromise(
    Effect.provide(startAgentServerEffect(options, scope), Context.make(Scope.Scope, scope)),
  );
  return {
    ...started,
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "qujing-agent-server-"));
  roots.push(root);
  const configPath = join(root, "config", "agent.json");
  const stateRoot = join(root, "state");
  const store = new AgentConfigStore({ configPath });
  const initialized = await Effect.runPromise(store.initEffect());
  if (!initialized.initialized) throw new Error("Agent did not initialize");
  const server = await start({ configPath, stateRoot, port: 0 });
  running.push(server);
  return { store, server, configPath, stateRoot, bearer: initialized.bearer };
}

async function connect(url: string, bearer: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
  });
  const agent = new Client({ name: "test", version: "1" });
  await agent.connect(transport as Parameters<Client["connect"]>[0]);
  return agent;
}

test("runs one local MCP endpoint and applies local token rotation", async () => {
  const { store, server, bearer } = await fixture();
  const first = await connect(server.url, bearer);
  expect((await first.listTools()).tools.map(({ name }) => name)).toEqual(["list_peers", "ask"]);

  const rotated = await Effect.runPromise(store.rotateLocalBearerEffect());
  await Bun.sleep(350);
  await expect(first.listTools()).rejects.toBeDefined();
  await first.close().catch(() => {});

  const second = await connect(server.url, rotated.bearer);
  expect((await second.listTools()).tools.map(({ name }) => name)).toEqual(["list_peers", "ask"]);
  await second.close();
});

test("does not rewrite reload acknowledgement while config is unchanged", async () => {
  const { stateRoot } = await fixture();
  const path = join(stateRoot, "agent-reload.json");
  const initial = await stat(path);

  await Bun.sleep(550);

  expect((await stat(path)).mtimeMs).toBe(initial.mtimeMs);
});

test("releases Agent resources when root Scope closes", async () => {
  const root = await mkdtemp(join(tmpdir(), "qujing-agent-server-scope-"));
  roots.push(root);
  const configPath = join(root, "config", "agent.json");
  const stateRoot = join(root, "state");
  await Effect.runPromise(new AgentConfigStore({ configPath }).initEffect());
  const scope = await Effect.runPromise(Scope.make("sequential"));
  await Effect.runPromise(
    Effect.provide(
      startAgentServerEffect({ configPath, stateRoot, port: 0 }, scope),
      Context.make(Scope.Scope, scope),
    ),
  );
  await Effect.runPromise(Scope.close(scope, Exit.void));

  const restarted = await start({ configPath, stateRoot, port: 0 });
  running.push(restarted);
  expect(await fetch(`${restarted.url}/healthz`).then((response) => response.json())).toEqual({
    status: "ok",
  });
});

test("holds one Agent process lock and releases it on close", async () => {
  const { server, configPath, stateRoot } = await fixture();
  await expect(start({ configPath, stateRoot, port: 0 })).rejects.toThrow("already running");
  await server.close();
  running.splice(running.indexOf(server), 1);

  const restarted = await start({ configPath, stateRoot, port: 0 });
  running.push(restarted);
  expect(await fetch(`${restarted.url}/healthz`).then((response) => response.json())).toEqual({
    status: "ok",
  });
});

test("rejects unsafe Agent state before acquiring process lock", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "qujing-agent-server-unsafe-"));
  roots.push(root);
  const configPath = join(root, "config", "agent.json");
  const stateRoot = join(root, "state");
  await Effect.runPromise(new AgentConfigStore({ configPath }).initEffect());
  await Bun.write(join(stateRoot, "entry"), "state");
  await chmod(stateRoot, 0o755);

  await expect(start({ configPath, stateRoot, port: 0 })).rejects.toThrow(
    "Private state permissions",
  );
  expect(await Bun.file(join(stateRoot, "agent.lock", "owner.json")).exists()).toBe(false);
});

test("retires active Peer before CLI credential update commits", async () => {
  const root = await mkdtemp(join(tmpdir(), "qujing-agent-rotation-"));
  roots.push(root);
  const configPath = join(root, "config", "agent.json");
  const stateRoot = join(root, "state");
  const oldKey = join(root, "keys", "old.json");
  const newKey = join(root, "keys", "new.json");
  await mkdir(join(root, "keys"), { recursive: true });
  await Promise.all([Bun.write(oldKey, "old-key"), Bun.write(newKey, "new-key")]);
  await Promise.all([chmod(oldKey, 0o600), chmod(newKey, 0o600)]);
  const store = new AgentConfigStore({ configPath });
  const initialized = await Effect.runPromise(store.initEffect());
  if (!initialized.initialized) throw new Error("Agent did not initialize");
  await Effect.runPromise(
    store.addEffect({
      id: "node",
      expectedNodeId: "node",
      remoteAgentId: "remote",
      serverAddress: "private",
      remotePort: 1,
      keyPath: oldKey,
      remoteBearer: "old-bearer",
    }),
  );

  let started!: () => void;
  const active = new Promise<void>((resolve) => {
    started = resolve;
  });
  let settled = false;
  let closed = false;
  const server = await start({
    configPath,
    stateRoot,
    port: 0,
    createRuntime: () =>
      ({
        listWorkspacesEffect: () =>
          Effect.succeed({
            node: { id: "node", name: "Node" },
            workspaces: [{ id: "docs", name: "Docs", summary: "Docs", available: true }],
          }),
        askEffect: (_workspace, _question, signal) =>
          Effect.tryPromise({
            try: () => {
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
            catch: (error) => error,
          }),
        closeEffect: () =>
          Effect.sync(() => {
            closed = true;
          }),
      }) satisfies PeerRuntimeAgent,
  });
  running.push(server);
  const agent = await connect(server.url, initialized.bearer);
  const pending = agent.callTool({
    name: "ask",
    arguments: { peer: "node", workspace: "docs", question: "wait" },
  });
  await active;

  const result = Effect.runPromise(
    runCliEffect(["peer", "update", "node", "--key", newKey, "--bearer", "-", "--yes"], {
      configPath: join(root, "unused-node.json"),
      stateRoot: join(root, "unused-node-state"),
      agentConfigPath: configPath,
      agentStateRoot: stateRoot,
      writeOut: () => {},
      writeError: () => {},
      readStdinEffect: () => Effect.succeed("new-bearer"),
      verifyPeerEffect: () => Effect.void,
      validateTailcatKeyEffect: () => Effect.void,
      agentDoctorEffect: () => Effect.succeed({ ok: true, checks: [] }),
      nodeReloadTimeoutMs: 2_000,
    }),
  );
  for (
    let attempt = 0;
    (await Effect.runPromise(store.getEffect("node")))?.remoteBearer === "old-bearer";
    attempt++
  ) {
    if (attempt > 100) throw new Error("credential update did not commit");
    await Bun.sleep(10);
  }
  expect({ settled, closed }).toEqual({ settled: true, closed: true });
  expect(await result).toBe(0);
  expect(await pending).toMatchObject({ isError: true });
  await agent.close();
});
