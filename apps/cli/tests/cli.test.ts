import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentConfigStore, type PeerConfig } from "../src/agent-config";
import { runCliEffect, type CliIo } from "../src/cli";
import { Effect } from "effect";
import { ConfigStore } from "../src/config";
import { acknowledgeNodeReloadEffect } from "../src/reload";
import { acquireMaintenanceLockEffect, acquireProcessLockEffect } from "../src/process-lock";
import { RuntimeSessionStore } from "../src/runtime/sessions";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "qujing-cli-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const stateRoot = join(root, "state");
  const transportRoot = join(stateRoot, "transport");
  await mkdir(transportRoot, { recursive: true, mode: 0o700 });
  await chmod(stateRoot, 0o700);
  await chmod(transportRoot, 0o700);
  const transportState = join(transportRoot, "server.json");
  await Bun.write(
    transportState,
    JSON.stringify({ serverAddress: "tailcat-address", remotePort: 43_110 }),
  );
  await chmod(transportState, 0o600);
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    configPath: join(root, "config", "config.json"),
    stateRoot,
    agentConfigPath: join(root, "config", "agent.json"),
    agentStateRoot: join(root, "agent-state"),
    writeOut: (text) => {
      stdout += text;
    },
    writeError: (text) => {
      stderr += text;
    },
    readStdinEffect: () => Effect.succeed(""),
    nodeReloadTimeoutMs: 1_000,
    validateTailcatKeyEffect: () => Effect.void,
    verifyPeerEffect: () => Effect.void,
  };
  return {
    io,
    workspace,
    output: () => ({ stdout, stderr }),
    clear: () => {
      stdout = "";
      stderr = "";
    },
  };
}

async function initNode(io: CliIo) {
  return Effect.runPromise(runCliEffect(["init", "--node-id", "node", "--node-name", "Node"], io));
}

async function addPeerCredential(io: CliIo, args: string[], id: string) {
  const release = await Effect.runPromise(
    acquireProcessLockEffect(join(io.stateRoot, "node.lock")),
  );
  try {
    const pending = Effect.runPromise(runCliEffect(args, io));
    let effective = await Effect.runPromise(new ConfigStore(io).readEffectiveEffect());
    for (
      let attempt = 0;
      !effective.peers.some((agent) => agent.id === id) && attempt < 200;
      attempt++
    ) {
      await Bun.sleep(5);
      effective = await Effect.runPromise(new ConfigStore(io).readEffectiveEffect());
    }
    if (!effective.peers.some((agent) => agent.id === id))
      throw new Error(`Node Agent was not created: ${id}`);
    await Effect.runPromise(acknowledgeNodeReloadEffect(io.stateRoot, effective));
    return await pending;
  } finally {
    await Effect.runPromise(release);
  }
}

async function privateKey(path: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await Bun.write(path, "private");
  await chmod(path, 0o600);
}

function pairing(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    nodeId: "node-jason",
    remoteAgentId: "alice-peer",
    serverAddress: "tailcat-address",
    remotePort: 43_110,
    remoteBearer: "remote-secret",
    ...overrides,
  };
}

describe("task-first CLI", () => {
  test("rejects invalid init port before creating either config", async () => {
    const { io } = await fixture();
    expect(
      await Effect.runPromise(
        runCliEffect(["init", "--node-id", "node", "--node-name", "Node", "--port", "0"], io),
      ),
    ).toBe(2);
    expect(await Bun.file(io.configPath).exists()).toBe(false);
    expect(await Bun.file(io.agentConfigPath).exists()).toBe(false);
  });

  test("runs authoritative Effect entrypoint", async () => {
    const { io, output } = await fixture();
    expect(
      await Effect.runPromise(
        runCliEffect(["init", "--node-id", "node", "--node-name", "Node"], io),
      ),
    ).toBe(0);
    expect(output().stdout).toContain("initialized Node:");
  });

  test("runs Node init, Workspace, and peer commands", async () => {
    const { io, workspace, output, clear } = await fixture();
    expect(await initNode(io)).toBe(0);
    clear();
    expect(
      await Effect.runPromise(
        runCliEffect(
          [
            "workspace",
            "add",
            "docs",
            "--name",
            "Docs",
            "--root",
            workspace,
            "--summary",
            "Product docs",
          ],
          io,
        ),
      ),
    ).toBe(0);
    clear();
    expect(await Effect.runPromise(runCliEffect(["workspace", "list", "--json"], io))).toBe(0);
    expect(JSON.parse(output().stdout)).toMatchObject([
      { id: "docs", root: await realpath(workspace) },
    ]);
    clear();
    expect(
      await addPeerCredential(io, ["peer", "invite", "agent", "--key", "public-key"], "agent"),
    ).toBe(0);
    expect(JSON.parse(output().stdout)).toMatchObject({
      version: 1,
      nodeId: "node",
      remoteAgentId: "agent",
      serverAddress: "tailcat-address",
      remotePort: 43_110,
    });
    expect(JSON.parse(output().stdout).remoteBearer).toBeString();
  });

  test("configures Node Runtime backend", async () => {
    const { io, output, clear } = await fixture();
    expect(await initNode(io)).toBe(0);

    clear();
    expect(
      await Effect.runPromise(
        runCliEffect(
          [
            "runtime",
            "set-acp",
            "codex",
            "--model",
            "test-model",
            "--command",
            "agent --acp --model {model} --cwd {cwd}",
            "--auth",
            "host",
            "--permission",
            "bypassPermissions",
          ],
          io,
        ),
      ),
    ).toBe(0);
    expect(output().stdout).toContain("runtime: tanstack-acp");
    expect((await Effect.runPromise(new ConfigStore(io).readEffect())).runtime).toMatchObject({
      kind: "tanstack-acp",
      name: "codex",
    });

    clear();
    expect(
      await Effect.runPromise(
        runCliEffect(["runtime", "set-pi", "--model", "openai-codex/gpt-5.5"], io),
      ),
    ).toBe(0);
    expect(output().stdout).toContain("runtime: pi-rpc");
    expect((await Effect.runPromise(new ConfigStore(io).readEffect())).runtime).toMatchObject({
      kind: "pi-rpc",
      model: "openai-codex/gpt-5.5",
    });
  });

  test("initializes one Agent and manages redacted Peers", async () => {
    const { io, output, clear } = await fixture();
    expect(
      await Effect.runPromise(
        runCliEffect(["init", "--node-id", "node", "--node-name", "Node", "--port", "43222"], io),
      ),
    ).toBe(0);
    expect(output().stdout).toContain("local-bearer:");
    expect(output().stdout).toContain("http://127.0.0.1:43222/mcp");
    const configText = await Bun.file(io.agentConfigPath).text();
    expect(configText).not.toContain(output().stdout.match(/local-bearer: (.+)/)?.[1] ?? "missing");

    const keyPath = join(io.agentStateRoot, "keys", "jason.json");
    await privateKey(keyPath);
    let verified = "";
    io.verifyPeerEffect = (peer) =>
      Effect.sync(() => {
        verified = `${peer.id}:${peer.expectedNodeId}`;
      });
    io.readStdinEffect = () => Effect.succeed(`${JSON.stringify(pairing())}\n`);
    clear();
    expect(
      await Effect.runPromise(runCliEffect(["peer", "accept", "jason", "--from", "-"], io)),
    ).toBe(0);
    expect(verified).toBe("jason:node-jason");
    clear();
    expect(await Effect.runPromise(runCliEffect(["peer", "list", "--json"], io))).toBe(0);
    const listed = output().stdout;
    expect(listed).toContain("alice-peer");
    expect(listed).not.toContain("remote-secret");
    expect(listed).not.toContain("tailcat-address");
    expect(listed).not.toContain(keyPath);
  });

  test("verifies rotated Peer credentials before atomic persistence", async () => {
    const { io } = await fixture();
    await Effect.runPromise(runCliEffect(["init", "--node-id", "node", "--node-name", "Node"], io));
    const firstKey = join(io.agentStateRoot, "first.key");
    const secondKey = join(io.agentStateRoot, "second.key");
    await privateKey(firstKey);
    await privateKey(secondKey);
    io.readStdinEffect = () =>
      Effect.succeed(JSON.stringify(pairing({ nodeId: "node", remoteBearer: "first-bearer" })));
    await Effect.runPromise(
      runCliEffect(["peer", "accept", "jason", "--from", "-", "--key", firstKey], io),
    );
    io.readStdinEffect = () => Effect.succeed("second-bearer");
    io.verifyPeerEffect = (peer) =>
      Effect.sync(() => {
        expect(peer.remoteBearer).toBe("second-bearer");
        throw new Error("Node mismatch");
      });
    expect(
      await Effect.runPromise(
        runCliEffect(["peer", "update", "jason", "--key", secondKey, "--bearer", "-", "--yes"], io),
      ),
    ).toBe(1);
    expect(
      await Effect.runPromise(
        new AgentConfigStore({ configPath: io.agentConfigPath }).getEffect("jason"),
      ),
    ).toMatchObject({ keyPath: firstKey, remoteBearer: "first-bearer" });
  });

  test("requires confirmation and prints layered copyable help", async () => {
    const { io, workspace, output, clear } = await fixture();
    await initNode(io);
    await Effect.runPromise(
      runCliEffect(
        ["workspace", "add", "docs", "--name", "Docs", "--root", workspace, "--summary", "Docs"],
        io,
      ),
    );
    expect(await Effect.runPromise(runCliEffect(["workspace", "remove", "docs"], io))).toBe(2);
    expect(output().stderr).toContain("--yes");
    clear();
    expect(await Effect.runPromise(runCliEffect(["peer", "accept", "--help"], io))).toBe(0);
    expect(output().stdout).toContain("Examples:");
    expect(output().stdout).toContain("--from");
    clear();
    expect(await Effect.runPromise(runCliEffect(["node", "workspace", "list"], io))).toBe(2);
    expect(output().stderr).toContain("Usage: qj");
  });

  test("accepts secrets on stdin and rejects unknown or extra arguments", async () => {
    const { io, output, clear } = await fixture();
    await initNode(io);
    let validated = "";
    io.readStdinEffect = () => Effect.succeed("nodekey:stdin\n");
    io.validateTailcatKeyEffect = (key) =>
      Effect.sync(() => {
        validated = key;
      });
    expect(await addPeerCredential(io, ["peer", "invite", "agent", "--key", "-"], "agent")).toBe(0);
    expect(validated).toBe("nodekey:stdin");
    clear();
    expect(await Effect.runPromise(runCliEffect(["peer", "list", "--bogus", "value"], io))).toBe(2);
    expect(output().stderr).toContain("Unknown option --bogus");
    clear();
    expect(await Effect.runPromise(runCliEffect(["peer", "list", "extra"], io))).toBe(2);
    expect(output().stderr).toContain("Usage: qj peer list");
    clear();
    expect(
      await Effect.runPromise(
        runCliEffect(["peer", "accept", "legacy", "--node-id", "node", "--from", "-"], io),
      ),
    ).toBe(2);
    expect(output().stderr).toContain("Unknown option --node-id");
    clear();
    io.readStdinEffect = () => Effect.succeed('{"remoteBearer":"do-not-log"}');
    expect(
      await Effect.runPromise(runCliEffect(["peer", "accept", "invalid", "--from", "-"], io)),
    ).toBe(2);
    expect(output().stderr).toContain("Invalid peer invite");
    expect(output().stderr).not.toContain("do-not-log");
  });

  test("writes and imports a private peer invite with the default Peer key", async () => {
    const { io, output, clear } = await fixture();
    await initNode(io);
    const pairingPath = join(io.stateRoot, "agent.pairing.json");
    clear();
    expect(
      await addPeerCredential(
        io,
        ["peer", "invite", "agent", "--key", "public-key", "--out", pairingPath],
        "agent",
      ),
    ).toBe(0);
    expect(output().stdout.trim()).toBe(`peer-invite: ${pairingPath}`);
    expect((await stat(pairingPath)).mode & 0o777).toBe(0o600);

    await Effect.runPromise(runCliEffect(["init", "--node-id", "node", "--node-name", "Node"], io));
    const keyPath = join(io.agentStateRoot, "keys", "jason.json");
    await privateKey(keyPath);
    let verified: PeerConfig | undefined;
    io.verifyPeerEffect = (peer) => Effect.sync(() => void (verified = peer));
    clear();
    expect(
      await Effect.runPromise(runCliEffect(["peer", "accept", "jason", "--from", pairingPath], io)),
    ).toBe(0);
    expect(verified).toMatchObject({
      id: "jason",
      expectedNodeId: "node",
      remoteAgentId: "agent",
      keyPath,
    });
  });

  test("does not create a peer when peer invite output cannot be created", async () => {
    const { io, output, clear } = await fixture();
    await initNode(io);
    const pairingPath = join(io.stateRoot, "existing.pairing.json");
    await privateKey(pairingPath);
    clear();
    const release = await Effect.runPromise(
      acquireProcessLockEffect(join(io.stateRoot, "node.lock")),
    );
    try {
      expect(
        await Effect.runPromise(
          runCliEffect(
            ["peer", "invite", "agent", "--key", "public-key", "--out", pairingPath],
            io,
          ),
        ),
      ).toBe(1);
      expect(output().stdout).toBe("");
      expect(await Bun.file(pairingPath).text()).toBe("private");
      expect((await Effect.runPromise(new ConfigStore(io).readEffect())).peers).toEqual([]);
    } finally {
      await Effect.runPromise(release);
    }
  });

  test("keeps the peer invite when Node reload fails", async () => {
    const { io, output, clear } = await fixture();
    await initNode(io);
    io.nodeReloadTimeoutMs = 5;
    const pairingPath = join(io.stateRoot, "recoverable.pairing.json");
    clear();
    const release = await Effect.runPromise(
      acquireProcessLockEffect(join(io.stateRoot, "node.lock")),
    );
    try {
      expect(
        await Effect.runPromise(
          runCliEffect(
            ["peer", "invite", "agent", "--key", "public-key", "--out", pairingPath],
            io,
          ),
        ),
      ).toBe(1);
      expect(output().stdout.trim()).toBe(`peer-invite: ${pairingPath}`);
      const bundle = JSON.parse(await Bun.file(pairingPath).text());
      expect(
        await Effect.runPromise(new ConfigStore(io).authenticateEffect(bundle.remoteBearer)),
      ).toMatchObject({ id: "agent" });
    } finally {
      await Effect.runPromise(release);
    }
  });

  test("rejects malformed Tailcat keys before persisting a peer", async () => {
    const { io, output, clear } = await fixture();
    await initNode(io);
    clear();
    io.validateTailcatKeyEffect = () =>
      Effect.sync(() => {
        throw new Error("Invalid Tailcat public key");
      });
    expect(
      await Effect.runPromise(runCliEffect(["peer", "invite", "agent", "--key", "bad"], io)),
    ).toBe(1);
    expect(output().stdout).toBe("");
    expect((await Effect.runPromise(new ConfigStore(io).readEffect())).peers).toEqual([]);
  });

  test("does not create a peer before Node transport is ready", async () => {
    const { io, output, clear } = await fixture();
    await initNode(io);
    await rm(join(io.stateRoot, "transport", "server.json"));
    clear();
    const release = await Effect.runPromise(
      acquireProcessLockEffect(join(io.stateRoot, "node.lock")),
    );
    try {
      expect(
        await Effect.runPromise(
          runCliEffect(["peer", "invite", "agent", "--key", "public-key"], io),
        ),
      ).toBe(1);
      expect(output().stderr).toContain("start Node before inviting a peer");
      expect((await Effect.runPromise(new ConfigStore(io).readEffect())).peers).toEqual([]);
    } finally {
      await Effect.runPromise(release);
    }
  });

  test("requires a live Node instead of offline maintenance", async () => {
    const { io, output } = await fixture();
    await initNode(io);
    io.nodeReloadTimeoutMs = 5;
    const release = await Effect.runPromise(acquireMaintenanceLockEffect(io.stateRoot));
    try {
      expect(
        await Effect.runPromise(
          runCliEffect(["peer", "invite", "agent", "--key", "nodekey:test"], io),
        ),
      ).toBe(1);
      expect(output().stderr).toContain("Node must be running");
      expect((await Effect.runPromise(new ConfigStore(io).readEffect())).peers).toEqual([]);
    } finally {
      await Effect.runPromise(release);
    }
  });

  test("leaves revoked history for running Node to abort before deletion", async () => {
    const { io } = await fixture();
    await initNode(io);
    await addPeerCredential(io, ["peer", "invite", "agent", "--key", "nodekey:test"], "agent");
    const sessions = new RuntimeSessionStore(io.stateRoot);
    const session = await Effect.runPromise(sessions.getOrCreateEffect("agent", "docs"));
    const release = await Effect.runPromise(
      acquireProcessLockEffect(join(io.stateRoot, "node.lock")),
    );
    try {
      let settled = false;
      const pending = Effect.runPromise(
        runCliEffect(["peer", "revoke", "agent", "--yes"], io),
      ).finally(() => {
        settled = true;
      });
      let effective = await Effect.runPromise(new ConfigStore(io).readEffectiveEffect());
      for (
        let attempt = 0;
        effective.peers.some((agent) => agent.id === "agent") && attempt < 200;
        attempt++
      ) {
        await Bun.sleep(5);
        effective = await Effect.runPromise(new ConfigStore(io).readEffectiveEffect());
      }
      expect(settled).toBe(false);
      await Effect.runPromise(acknowledgeNodeReloadEffect(io.stateRoot, effective));
      expect(await pending).toBe(0);
      expect((await Effect.runPromise(sessions.listEffect())).map(({ id }) => id)).toContain(
        session.id,
      );
    } finally {
      await Effect.runPromise(release);
    }
  });

  test("does not persist an unverified Peer and rejects legacy direct-connect commands", async () => {
    const { io, output } = await fixture();
    await Effect.runPromise(runCliEffect(["init", "--node-id", "node", "--node-name", "Node"], io));
    const keyPath = join(io.agentStateRoot, "rejected.key");
    await privateKey(keyPath);
    io.readStdinEffect = () =>
      Effect.succeed(JSON.stringify(pairing({ nodeId: "node", remoteBearer: "remote-bearer" })));
    io.verifyPeerEffect = () =>
      Effect.sync(() => {
        throw new Error("Node identity mismatch");
      });
    expect(
      await Effect.runPromise(
        runCliEffect(["peer", "accept", "bad", "--from", "-", "--key", keyPath], io),
      ),
    ).toBe(1);
    expect(
      await Effect.runPromise(
        new AgentConfigStore({ configPath: io.agentConfigPath }).listEffect(),
      ),
    ).toEqual([]);
    expect(
      await Effect.runPromise(
        runCliEffect(["node", "peer", "add", "legacy", "--tailcat-key", "key"], io),
      ),
    ).toBe(2);
    expect(output().stderr).toContain("Usage: qj");
  });
});
