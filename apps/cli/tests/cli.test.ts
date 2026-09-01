import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientConfigStore } from "../src/client-config";
import { createShutdownWaiter, runCli, type CliIo } from "../src/cli";
import { ConfigStore } from "../src/config";
import { acknowledgeGatewayReload } from "../src/gateway-reload";
import { acquireMaintenanceLock, acquireProcessLock } from "../src/process-lock";
import { RuntimeSessionStore } from "../src/runtime/sessions";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "colleague-line-cli-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    configPath: join(root, "config", "config.json"),
    stateRoot: join(root, "state"),
    clientConfigPath: join(root, "config", "client.json"),
    clientStateRoot: join(root, "client-state"),
    writeOut: (text) => {
      stdout += text;
    },
    writeError: (text) => {
      stderr += text;
    },
    readStdin: async () => "",
    gatewayReloadTimeoutMs: 1_000,
    validateTailcatKey: async () => {},
    verifyLine: async () => {},
    clientDoctor: async () => ({ ok: true, checks: [] }),
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
  return runCli(["gateway", "init", "--owner-id", "owner", "--owner-name", "Owner"], io);
}

async function privateKey(path: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await Bun.write(path, "private");
  await chmod(path, 0o600);
}

describe("role CLI", () => {
  test("removes both signal listeners after shutdown or disposal", async () => {
    const signals = new EventEmitter();
    const first = createShutdownWaiter(signals);
    expect(signals.listenerCount("SIGINT")).toBe(1);
    expect(signals.listenerCount("SIGTERM")).toBe(1);
    signals.emit("SIGINT");
    await first.promise;
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    const second = createShutdownWaiter(signals);
    second.dispose();
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  test("runs Gateway init, Workspace, and remote Client commands", async () => {
    const { io, workspace, output, clear } = await fixture();
    expect(await initGateway(io)).toBe(0);
    clear();
    expect(
      await runCli(
        [
          "gateway",
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
    ).toBe(0);
    clear();
    expect(await runCli(["gateway", "workspace", "list", "--json"], io)).toBe(0);
    expect(JSON.parse(output().stdout)).toMatchObject([
      { id: "docs", root: await realpath(workspace) },
    ]);
    clear();
    expect(
      await runCli(["gateway", "client", "add", "agent", "--tailcat-key", "public-key"], io),
    ).toBe(0);
    expect(output().stdout).toContain("bearer:");
  });

  test("initializes one Client and manages redacted Lines", async () => {
    const { io, output, clear } = await fixture();
    expect(await runCli(["client", "init", "--port", "43222"], io)).toBe(0);
    expect(output().stdout).toContain("local-bearer:");
    expect(output().stdout).toContain("http://127.0.0.1:43222/mcp");
    const configText = await Bun.file(io.clientConfigPath).text();
    expect(configText).not.toContain(output().stdout.match(/local-bearer: (.+)/)?.[1] ?? "missing");

    const keyPath = join(io.clientStateRoot, "keys", "owner.json");
    await privateKey(keyPath);
    let verified = "";
    io.verifyLine = async (line) => {
      verified = `${line.id}:${line.expectedOwnerId}`;
    };
    io.readStdin = async () => "remote-secret\n";
    clear();
    expect(
      await runCli(
        [
          "client",
          "line",
          "add",
          "jason",
          "--owner-id",
          "owner-jason",
          "--remote-client-id",
          "alice-line",
          "--server",
          "tailcat-address",
          "--port",
          "43110",
          "--key",
          keyPath,
          "--bearer",
          "-",
        ],
        io,
      ),
    ).toBe(0);
    expect(verified).toBe("jason:owner-jason");
    clear();
    expect(await runCli(["client", "line", "list", "--json"], io)).toBe(0);
    const listed = output().stdout;
    expect(listed).toContain("alice-line");
    expect(listed).not.toContain("remote-secret");
    expect(listed).not.toContain("tailcat-address");
    expect(listed).not.toContain(keyPath);
  });

  test("verifies rotated Line credentials before atomic persistence", async () => {
    const { io } = await fixture();
    await runCli(["client", "init"], io);
    const firstKey = join(io.clientStateRoot, "first.key");
    const secondKey = join(io.clientStateRoot, "second.key");
    await privateKey(firstKey);
    await privateKey(secondKey);
    io.readStdin = async () => "first-bearer";
    await runCli(
      [
        "client",
        "line",
        "add",
        "jason",
        "--owner-id",
        "owner",
        "--remote-client-id",
        "remote",
        "--server",
        "tailcat",
        "--port",
        "43110",
        "--key",
        firstKey,
        "--bearer",
        "-",
      ],
      io,
    );
    io.readStdin = async () => "second-bearer";
    io.verifyLine = async (line) => {
      expect(line.remoteBearer).toBe("second-bearer");
      throw new Error("Owner mismatch");
    };
    expect(
      await runCli(
        ["client", "line", "update", "jason", "--key", secondKey, "--bearer", "-", "--yes"],
        io,
      ),
    ).toBe(1);
    expect(
      await new ClientConfigStore({ configPath: io.clientConfigPath }).get("jason"),
    ).toMatchObject({ keyPath: firstKey, remoteBearer: "first-bearer" });
  });

  test("requires confirmation and prints layered copyable help", async () => {
    const { io, workspace, output, clear } = await fixture();
    await initGateway(io);
    await runCli(
      [
        "gateway",
        "workspace",
        "add",
        "docs",
        "--name",
        "Docs",
        "--root",
        workspace,
        "--summary",
        "Docs",
      ],
      io,
    );
    expect(await runCli(["gateway", "workspace", "remove", "docs"], io)).toBe(2);
    expect(output().stderr).toContain("--yes");
    clear();
    expect(await runCli(["client", "line", "add", "--help"], io)).toBe(0);
    expect(output().stdout).toContain("Examples:");
    expect(output().stdout).toContain("remote-client-id");
    clear();
    expect(await runCli(["workspace", "list"], io)).toBe(2);
    expect(output().stderr).toContain("gateway|client");
  });

  test("accepts secrets on stdin and rejects unknown or extra arguments", async () => {
    const { io, output, clear } = await fixture();
    await initGateway(io);
    let validated = "";
    io.readStdin = async () => "nodekey:stdin\n";
    io.validateTailcatKey = async (key) => {
      validated = key;
    };
    expect(await runCli(["gateway", "client", "add", "agent", "--tailcat-key", "-"], io)).toBe(0);
    expect(validated).toBe("nodekey:stdin");
    clear();
    expect(await runCli(["gateway", "client", "list", "--bogus", "value"], io)).toBe(2);
    expect(output().stderr).toContain("Unknown option --bogus");
    clear();
    expect(await runCli(["client", "line", "list", "extra"], io)).toBe(2);
    expect(output().stderr).toContain("Usage: colleague-line client line list");
  });

  test("rejects malformed Tailcat keys before persisting a remote Client", async () => {
    const { io, output } = await fixture();
    await initGateway(io);
    io.validateTailcatKey = async () => {
      throw new Error("Invalid Tailcat public key");
    };
    expect(await runCli(["gateway", "client", "add", "agent", "--tailcat-key", "bad"], io)).toBe(1);
    expect(output().stdout).not.toContain("bearer:");
    expect((await new ConfigStore(io).read()).clients).toEqual([]);
  });

  test("does not mistake offline maintenance for a running Gateway", async () => {
    const { io } = await fixture();
    await initGateway(io);
    io.gatewayReloadTimeoutMs = 5;
    const release = await acquireMaintenanceLock(io.stateRoot);
    try {
      expect(
        await runCli(["gateway", "client", "add", "agent", "--tailcat-key", "nodekey:test"], io),
      ).toBe(0);
    } finally {
      await release();
    }
  });

  test("leaves revoked history for running Gateway to abort before deletion", async () => {
    const { io } = await fixture();
    await initGateway(io);
    await runCli(["gateway", "client", "add", "agent", "--tailcat-key", "nodekey:test"], io);
    const sessions = new RuntimeSessionStore(io.stateRoot);
    const session = await sessions.getOrCreate("agent", "docs");
    const release = await acquireProcessLock(join(io.stateRoot, "gateway.lock"));
    try {
      let settled = false;
      const pending = runCli(["gateway", "client", "revoke", "agent", "--yes"], io).finally(() => {
        settled = true;
      });
      let effective = await new ConfigStore(io).readEffective();
      for (
        let attempt = 0;
        effective.clients.some((client) => client.id === "agent") && attempt < 200;
        attempt++
      ) {
        await Bun.sleep(5);
        effective = await new ConfigStore(io).readEffective();
      }
      expect(settled).toBe(false);
      await acknowledgeGatewayReload(io.stateRoot, effective);
      expect(await pending).toBe(0);
      expect((await sessions.list()).map(({ id }) => id)).toContain(session.id);
    } finally {
      await release();
    }
  });

  test("does not persist an unverified Line and rejects legacy direct-connect commands", async () => {
    const { io, output } = await fixture();
    await runCli(["client", "init"], io);
    const keyPath = join(io.clientStateRoot, "rejected.key");
    await privateKey(keyPath);
    io.readStdin = async () => "remote-bearer";
    io.verifyLine = async () => {
      throw new Error("Owner identity mismatch");
    };
    expect(
      await runCli(
        [
          "client",
          "line",
          "add",
          "bad",
          "--owner-id",
          "owner",
          "--remote-client-id",
          "remote",
          "--server",
          "tailcat",
          "--port",
          "43110",
          "--key",
          keyPath,
          "--bearer",
          "-",
        ],
        io,
      ),
    ).toBe(1);
    expect(await new ClientConfigStore({ configPath: io.clientConfigPath }).list()).toEqual([]);
    expect(await runCli(["client", "connect", "owner"], io)).toBe(2);
    expect(await runCli(["client", "profile", "list"], io)).toBe(2);
    expect(output().stderr).toContain("Usage: colleague-line");
  });
});
