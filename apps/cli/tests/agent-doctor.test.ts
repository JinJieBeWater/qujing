import { afterEach, expect, test } from "bun:test";
import { Effect } from "effect";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentConfigStore } from "../src/agent-config";
import { runAgentDoctorEffect } from "../src/agent-doctor";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("checks private Agent state, transport, port, and each Peer independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "qujing-agent-doctor-"));
  roots.push(root);
  const configPath = join(root, "config", "agent.json");
  const stateRoot = join(root, "state");
  const transportBinary = join(root, "transport");
  const keyPath = join(root, "peer.key");
  await Bun.write(transportBinary, "binary");
  await chmod(transportBinary, 0o700);
  await Bun.write(keyPath, "key");
  await chmod(keyPath, 0o600);
  const store = new AgentConfigStore({ configPath });
  await Effect.runPromise(store.initEffect({ port: 43222 }));
  await Effect.runPromise(
    store.addEffect({
      id: "one",
      expectedNodeId: "node",
      remoteAgentId: "remote",
      serverAddress: "tailcat",
      remotePort: 43110,
      keyPath,
      remoteBearer: "bearer",
    }),
  );

  const report = await Effect.runPromise(
    runAgentDoctorEffect(
      { agentConfigPath: configPath, agentStateRoot: stateRoot, transportBinary },
      {
        checkPort: () => Effect.succeed(true),
        inspectPeers: () => Effect.succeed([{ id: "one", available: false }]),
      },
    ),
  );
  expect(report.ok).toBe(false);
  expect(report.checks).toEqual(
    expect.arrayContaining([
      { name: "config", status: "ok", message: "Agent config is valid and private" },
      { name: "peer-key:one", status: "ok", message: "Peer key is private" },
      { name: "peer:one", status: "error", message: "Peer is unavailable" },
    ]),
  );
});

test("reports unsafe Agent state permissions", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "qujing-agent-doctor-state-"));
  roots.push(root);
  const configPath = join(root, "config", "agent.json");
  const stateRoot = join(root, "state");
  const transportBinary = join(root, "transport");
  await Bun.write(transportBinary, "binary");
  await chmod(transportBinary, 0o700);
  await Bun.write(join(stateRoot, "entry"), "state");
  await chmod(stateRoot, 0o755);
  const store = new AgentConfigStore({ configPath });
  await Effect.runPromise(store.initEffect());
  const report = await Effect.runPromise(
    runAgentDoctorEffect(
      { agentConfigPath: configPath, agentStateRoot: stateRoot, transportBinary },
      { checkPort: () => Effect.succeed(true), inspectPeers: () => Effect.succeed([]) },
    ),
  );
  expect(report.checks.find(({ name }) => name === "state")?.status).toBe("error");
});

test("reports invalid Agent config without aborting doctor", async () => {
  const root = await mkdtemp(join(tmpdir(), "qujing-agent-doctor-config-"));
  roots.push(root);
  const configPath = join(root, "config", "agent.json");
  const stateRoot = join(root, "state");
  const transportBinary = join(root, "transport");
  await Bun.write(transportBinary, "binary");
  await chmod(transportBinary, 0o700);
  await Effect.runPromise(new AgentConfigStore({ configPath }).initEffect());
  await Bun.write(configPath, "not-json");
  if (process.platform !== "win32") await chmod(configPath, 0o600);

  const report = await Effect.runPromise(
    runAgentDoctorEffect({
      agentConfigPath: configPath,
      agentStateRoot: stateRoot,
      transportBinary,
    }),
  );

  expect(report.ok).toBe(false);
  expect(report.checks.find(({ name }) => name === "config")?.status).toBe("error");
});
