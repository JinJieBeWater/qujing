import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientConfigStore, type LineConfig } from "../src/client-config";
import { runCliEffect, type CliIo } from "../src/cli";
import { Effect } from "effect";
import { ConfigStore } from "../src/config";
import { acknowledgeGatewayReloadEffect } from "../src/gateway-reload";
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
    clientConfigPath: join(root, "config", "client.json"),
    clientStateRoot: join(root, "client-state"),
    writeOut: (text) => {
      stdout += text;
    },
    writeError: (text) => {
      stderr += text;
    },
    readStdinEffect: () => Effect.succeed(""),
    gatewayReloadTimeoutMs: 1_000,
    validateTailcatKeyEffect: () => Effect.void,
    verifyLineEffect: () => Effect.void,
    clientDoctorEffect: () => Effect.succeed({ ok: true, checks: [] }),
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

async function initGateway(io: CliIo) {
  return Effect.runPromise(
    runCliEffect(["init", "gateway", "--owner-id", "owner", "--owner-name", "Owner"], io),
  );
}

async function addGatewayClient(io: CliIo, args: string[], id: string) {
  const release = await Effect.runPromise(
    acquireProcessLockEffect(join(io.stateRoot, "gateway.lock")),
  );
  try {
    const pending = Effect.runPromise(runCliEffect(args, io));
    let effective = await Effect.runPromise(new ConfigStore(io).readEffectiveEffect());
    for (
      let attempt = 0;
      !effective.clients.some((client) => client.id === id) && attempt < 200;
      attempt++
    ) {
      await Bun.sleep(5);
      effective = await Effect.runPromise(new ConfigStore(io).readEffectiveEffect());
    }
    if (!effective.clients.some((client) => client.id === id))
      throw new Error(`Gateway Client was not created: ${id}`);
    await Effect.runPromise(acknowledgeGatewayReloadEffect(io.stateRoot, effective));
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
    ownerId: "owner-jason",
    remoteClientId: "alice-line",
    serverAddress: "tailcat-address",
    remotePort: 43_110,
    remoteBearer: "remote-secret",
    ...overrides,
  };
}

describe("task-first CLI", () => {
  test("runs authoritative Effect entrypoint", async () => {
    const { io, output } = await fixture();
    expect(
      await Effect.runPromise(
        runCliEffect(["init", "gateway", "--owner-id", "owner", "--owner-name", "Owner"], io),
      ),
    ).toBe(0);
    expect(output().stdout).toContain("initialized Gateway:");
  });

  test("runs Gateway init, Workspace, and remote Client commands", async () => {
    const { io, workspace, output, clear } = await fixture();
    expect(await initGateway(io)).toBe(0);
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
      await addGatewayClient(io, ["pair", "create", "agent", "--key", "public-key"], "agent"),
    ).toBe(0);
    expect(JSON.parse(output().stdout)).toMatchObject({
      version: 1,
      ownerId: "owner",
      remoteClientId: "agent",
      serverAddress: "tailcat-address",
      remotePort: 43_110,
    });
    expect(JSON.parse(output().stdout).remoteBearer).toBeString();
  });

  test("configures Gateway Runtime backend", async () => {
    const { io, output, clear } = await fixture();
    expect(await initGateway(io)).toBe(0);

    clear();
    expect(
      await Effect.runPromise(
        runCliEffect(
          [
            "runtime",
            "set-acp",
            "codex",
            "--model",
            "gpt-5-codex",
            "--command",
            "codex --acp --model {model} --cwd {cwd}",
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
    expect(await Effect.runPromise(runCliEffect(["runtime", "use-pi"], io))).toBe(0);
    expect(output().stdout).toContain("runtime: pi");
    expect((await Effect.runPromise(new ConfigStore(io).readEffect())).runtime).toBeUndefined();
  });

  test("initializes one Client and manages redacted Lines", async () => {
    const { io, output, clear } = await fixture();
    expect(await Effect.runPromise(runCliEffect(["init", "client", "--port", "43222"], io))).toBe(
      0,
    );
    expect(output().stdout).toContain("local-bearer:");
    expect(output().stdout).toContain("http://127.0.0.1:43222/mcp");
    const configText = await Bun.file(io.clientConfigPath).text();
    expect(configText).not.toContain(output().stdout.match(/local-bearer: (.+)/)?.[1] ?? "missing");

    const keyPath = join(io.clientStateRoot, "keys", "jason.json");
    await privateKey(keyPath);
    let verified = "";
    io.verifyLineEffect = (line) =>
      Effect.sync(() => {
        verified = `${line.id}:${line.expectedOwnerId}`;
      });
    io.readStdinEffect = () => Effect.succeed(`${JSON.stringify(pairing())}\n`);
    clear();
    expect(
      await Effect.runPromise(runCliEffect(["pair", "accept", "jason", "--from", "-"], io)),
    ).toBe(0);
    expect(verified).toBe("jason:owner-jason");
    clear();
    expect(await Effect.runPromise(runCliEffect(["line", "list", "--json"], io))).toBe(0);
    const listed = output().stdout;
    expect(listed).toContain("alice-line");
    expect(listed).not.toContain("remote-secret");
    expect(listed).not.toContain("tailcat-address");
    expect(listed).not.toContain(keyPath);
  });

  test("verifies rotated Line credentials before atomic persistence", async () => {
    const { io } = await fixture();
    await Effect.runPromise(runCliEffect(["init", "client"], io));
    const firstKey = join(io.clientStateRoot, "first.key");
    const secondKey = join(io.clientStateRoot, "second.key");
    await privateKey(firstKey);
    await privateKey(secondKey);
    io.readStdinEffect = () =>
      Effect.succeed(JSON.stringify(pairing({ ownerId: "owner", remoteBearer: "first-bearer" })));
    await Effect.runPromise(
      runCliEffect(["pair", "accept", "jason", "--from", "-", "--key", firstKey], io),
    );
    io.readStdinEffect = () => Effect.succeed("second-bearer");
    io.verifyLineEffect = (line) =>
      Effect.sync(() => {
        expect(line.remoteBearer).toBe("second-bearer");
        throw new Error("Owner mismatch");
      });
    expect(
      await Effect.runPromise(
        runCliEffect(["line", "update", "jason", "--key", secondKey, "--bearer", "-", "--yes"], io),
      ),
    ).toBe(1);
    expect(
      await Effect.runPromise(
        new ClientConfigStore({ configPath: io.clientConfigPath }).getEffect("jason"),
      ),
    ).toMatchObject({ keyPath: firstKey, remoteBearer: "first-bearer" });
  });

  test("requires confirmation and prints layered copyable help", async () => {
    const { io, workspace, output, clear } = await fixture();
    await initGateway(io);
    await Effect.runPromise(
      runCliEffect(
        ["workspace", "add", "docs", "--name", "Docs", "--root", workspace, "--summary", "Docs"],
        io,
      ),
    );
    expect(await Effect.runPromise(runCliEffect(["workspace", "remove", "docs"], io))).toBe(2);
    expect(output().stderr).toContain("--yes");
    clear();
    expect(await Effect.runPromise(runCliEffect(["pair", "accept", "--help"], io))).toBe(0);
    expect(output().stdout).toContain("Examples:");
    expect(output().stdout).toContain("--from");
    clear();
    expect(await Effect.runPromise(runCliEffect(["gateway", "workspace", "list"], io))).toBe(2);
    expect(output().stderr).toContain("Usage: qj");
  });

  test("accepts secrets on stdin and rejects unknown or extra arguments", async () => {
    const { io, output, clear } = await fixture();
    await initGateway(io);
    let validated = "";
    io.readStdinEffect = () => Effect.succeed("nodekey:stdin\n");
    io.validateTailcatKeyEffect = (key) =>
      Effect.sync(() => {
        validated = key;
      });
    expect(await addGatewayClient(io, ["pair", "create", "agent", "--key", "-"], "agent")).toBe(0);
    expect(validated).toBe("nodekey:stdin");
    clear();
    expect(await Effect.runPromise(runCliEffect(["pair", "list", "--bogus", "value"], io))).toBe(2);
    expect(output().stderr).toContain("Unknown option --bogus");
    clear();
    expect(await Effect.runPromise(runCliEffect(["line", "list", "extra"], io))).toBe(2);
    expect(output().stderr).toContain("Usage: qj line list");
    clear();
    expect(
      await Effect.runPromise(
        runCliEffect(["pair", "accept", "legacy", "--owner-id", "owner", "--from", "-"], io),
      ),
    ).toBe(2);
    expect(output().stderr).toContain("Unknown option --owner-id");
    clear();
    io.readStdinEffect = () => Effect.succeed('{"remoteBearer":"do-not-log"}');
    expect(
      await Effect.runPromise(runCliEffect(["pair", "accept", "invalid", "--from", "-"], io)),
    ).toBe(2);
    expect(output().stderr).toContain("Invalid pairing bundle");
    expect(output().stderr).not.toContain("do-not-log");
  });

  test("writes and imports a private pairing bundle with the default Line key", async () => {
    const { io, output, clear } = await fixture();
    await initGateway(io);
    const pairingPath = join(io.stateRoot, "agent.pairing.json");
    clear();
    expect(
      await addGatewayClient(
        io,
        ["pair", "create", "agent", "--key", "public-key", "--out", pairingPath],
        "agent",
      ),
    ).toBe(0);
    expect(output().stdout.trim()).toBe(`pairing: ${pairingPath}`);
    expect((await stat(pairingPath)).mode & 0o777).toBe(0o600);

    await Effect.runPromise(runCliEffect(["init", "client"], io));
    const keyPath = join(io.clientStateRoot, "keys", "jason.json");
    await privateKey(keyPath);
    let verified: LineConfig | undefined;
    io.verifyLineEffect = (line) => Effect.sync(() => void (verified = line));
    clear();
    expect(
      await Effect.runPromise(runCliEffect(["pair", "accept", "jason", "--from", pairingPath], io)),
    ).toBe(0);
    expect(verified).toMatchObject({
      id: "jason",
      expectedOwnerId: "owner",
      remoteClientId: "agent",
      keyPath,
    });
  });

  test("does not create a remote Client when pairing output cannot be created", async () => {
    const { io, output, clear } = await fixture();
    await initGateway(io);
    const pairingPath = join(io.stateRoot, "existing.pairing.json");
    await privateKey(pairingPath);
    clear();
    const release = await Effect.runPromise(
      acquireProcessLockEffect(join(io.stateRoot, "gateway.lock")),
    );
    try {
      expect(
        await Effect.runPromise(
          runCliEffect(
            ["pair", "create", "agent", "--key", "public-key", "--out", pairingPath],
            io,
          ),
        ),
      ).toBe(1);
      expect(output().stdout).toBe("");
      expect(await Bun.file(pairingPath).text()).toBe("private");
      expect((await Effect.runPromise(new ConfigStore(io).readEffect())).clients).toEqual([]);
    } finally {
      await Effect.runPromise(release);
    }
  });

  test("keeps the pairing bundle when Gateway reload fails", async () => {
    const { io, output, clear } = await fixture();
    await initGateway(io);
    io.gatewayReloadTimeoutMs = 5;
    const pairingPath = join(io.stateRoot, "recoverable.pairing.json");
    clear();
    const release = await Effect.runPromise(
      acquireProcessLockEffect(join(io.stateRoot, "gateway.lock")),
    );
    try {
      expect(
        await Effect.runPromise(
          runCliEffect(
            ["pair", "create", "agent", "--key", "public-key", "--out", pairingPath],
            io,
          ),
        ),
      ).toBe(1);
      expect(output().stdout.trim()).toBe(`pairing: ${pairingPath}`);
      const bundle = JSON.parse(await Bun.file(pairingPath).text());
      expect(
        await Effect.runPromise(new ConfigStore(io).authenticateEffect(bundle.remoteBearer)),
      ).toMatchObject({ id: "agent" });
    } finally {
      await Effect.runPromise(release);
    }
  });

  test("rejects malformed Tailcat keys before persisting a remote Client", async () => {
    const { io, output, clear } = await fixture();
    await initGateway(io);
    clear();
    io.validateTailcatKeyEffect = () =>
      Effect.sync(() => {
        throw new Error("Invalid Tailcat public key");
      });
    expect(
      await Effect.runPromise(runCliEffect(["pair", "create", "agent", "--key", "bad"], io)),
    ).toBe(1);
    expect(output().stdout).toBe("");
    expect((await Effect.runPromise(new ConfigStore(io).readEffect())).clients).toEqual([]);
  });

  test("does not create a remote Client before Gateway transport is ready", async () => {
    const { io, output, clear } = await fixture();
    await initGateway(io);
    await rm(join(io.stateRoot, "transport", "server.json"));
    clear();
    const release = await Effect.runPromise(
      acquireProcessLockEffect(join(io.stateRoot, "gateway.lock")),
    );
    try {
      expect(
        await Effect.runPromise(
          runCliEffect(["pair", "create", "agent", "--key", "public-key"], io),
        ),
      ).toBe(1);
      expect(output().stderr).toContain("start Gateway before pairing");
      expect((await Effect.runPromise(new ConfigStore(io).readEffect())).clients).toEqual([]);
    } finally {
      await Effect.runPromise(release);
    }
  });

  test("requires a live Gateway instead of offline maintenance", async () => {
    const { io, output } = await fixture();
    await initGateway(io);
    io.gatewayReloadTimeoutMs = 5;
    const release = await Effect.runPromise(acquireMaintenanceLockEffect(io.stateRoot));
    try {
      expect(
        await Effect.runPromise(
          runCliEffect(["pair", "create", "agent", "--key", "nodekey:test"], io),
        ),
      ).toBe(1);
      expect(output().stderr).toContain("Gateway must be running");
      expect((await Effect.runPromise(new ConfigStore(io).readEffect())).clients).toEqual([]);
    } finally {
      await Effect.runPromise(release);
    }
  });

  test("leaves revoked history for running Gateway to abort before deletion", async () => {
    const { io } = await fixture();
    await initGateway(io);
    await addGatewayClient(io, ["pair", "create", "agent", "--key", "nodekey:test"], "agent");
    const sessions = new RuntimeSessionStore(io.stateRoot);
    const session = await Effect.runPromise(sessions.getOrCreateEffect("agent", "docs"));
    const release = await Effect.runPromise(
      acquireProcessLockEffect(join(io.stateRoot, "gateway.lock")),
    );
    try {
      let settled = false;
      const pending = Effect.runPromise(
        runCliEffect(["pair", "revoke", "agent", "--yes"], io),
      ).finally(() => {
        settled = true;
      });
      let effective = await Effect.runPromise(new ConfigStore(io).readEffectiveEffect());
      for (
        let attempt = 0;
        effective.clients.some((client) => client.id === "agent") && attempt < 200;
        attempt++
      ) {
        await Bun.sleep(5);
        effective = await Effect.runPromise(new ConfigStore(io).readEffectiveEffect());
      }
      expect(settled).toBe(false);
      await Effect.runPromise(acknowledgeGatewayReloadEffect(io.stateRoot, effective));
      expect(await pending).toBe(0);
      expect((await Effect.runPromise(sessions.listEffect())).map(({ id }) => id)).toContain(
        session.id,
      );
    } finally {
      await Effect.runPromise(release);
    }
  });

  test("does not persist an unverified Line and rejects legacy direct-connect commands", async () => {
    const { io, output } = await fixture();
    await Effect.runPromise(runCliEffect(["init", "client"], io));
    const keyPath = join(io.clientStateRoot, "rejected.key");
    await privateKey(keyPath);
    io.readStdinEffect = () =>
      Effect.succeed(JSON.stringify(pairing({ ownerId: "owner", remoteBearer: "remote-bearer" })));
    io.verifyLineEffect = () =>
      Effect.sync(() => {
        throw new Error("Owner identity mismatch");
      });
    expect(
      await Effect.runPromise(
        runCliEffect(["pair", "accept", "bad", "--from", "-", "--key", keyPath], io),
      ),
    ).toBe(1);
    expect(
      await Effect.runPromise(
        new ClientConfigStore({ configPath: io.clientConfigPath }).listEffect(),
      ),
    ).toEqual([]);
    expect(await Effect.runPromise(runCliEffect(["client", "connect", "owner"], io))).toBe(2);
    expect(await Effect.runPromise(runCliEffect(["client", "profile", "list"], io))).toBe(2);
    expect(
      await Effect.runPromise(
        runCliEffect(["gateway", "client", "add", "legacy", "--tailcat-key", "key"], io),
      ),
    ).toBe(2);
    expect(
      await Effect.runPromise(
        runCliEffect(["client", "line", "add", "legacy", "--pairing", "-"], io),
      ),
    ).toBe(2);
    expect(output().stderr).toContain("Usage: qj");
  });
});
