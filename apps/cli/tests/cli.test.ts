import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientConfigStore } from "../src/client-config";
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
    runCliEffect(["gateway", "init", "--owner-id", "owner", "--owner-name", "Owner"], io),
  );
}

async function privateKey(path: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await Bun.write(path, "private");
  await chmod(path, 0o600);
}

describe("role CLI", () => {
  test("runs authoritative Effect entrypoint", async () => {
    const { io, output } = await fixture();
    expect(
      await Effect.runPromise(
        runCliEffect(["gateway", "init", "--owner-id", "owner", "--owner-name", "Owner"], io),
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
      ),
    ).toBe(0);
    clear();
    expect(
      await Effect.runPromise(runCliEffect(["gateway", "workspace", "list", "--json"], io)),
    ).toBe(0);
    expect(JSON.parse(output().stdout)).toMatchObject([
      { id: "docs", root: await realpath(workspace) },
    ]);
    clear();
    expect(
      await Effect.runPromise(
        runCliEffect(["gateway", "client", "add", "agent", "--tailcat-key", "public-key"], io),
      ),
    ).toBe(0);
    expect(output().stdout).toContain("bearer:");
  });

  test("initializes one Client and manages redacted Lines", async () => {
    const { io, output, clear } = await fixture();
    expect(await Effect.runPromise(runCliEffect(["client", "init", "--port", "43222"], io))).toBe(
      0,
    );
    expect(output().stdout).toContain("local-bearer:");
    expect(output().stdout).toContain("http://127.0.0.1:43222/mcp");
    const configText = await Bun.file(io.clientConfigPath).text();
    expect(configText).not.toContain(output().stdout.match(/local-bearer: (.+)/)?.[1] ?? "missing");

    const keyPath = join(io.clientStateRoot, "keys", "owner.json");
    await privateKey(keyPath);
    let verified = "";
    io.verifyLineEffect = (line) =>
      Effect.sync(() => {
        verified = `${line.id}:${line.expectedOwnerId}`;
      });
    io.readStdinEffect = () => Effect.succeed("remote-secret\n");
    clear();
    expect(
      await Effect.runPromise(
        runCliEffect(
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
      ),
    ).toBe(0);
    expect(verified).toBe("jason:owner-jason");
    clear();
    expect(await Effect.runPromise(runCliEffect(["client", "line", "list", "--json"], io))).toBe(0);
    const listed = output().stdout;
    expect(listed).toContain("alice-line");
    expect(listed).not.toContain("remote-secret");
    expect(listed).not.toContain("tailcat-address");
    expect(listed).not.toContain(keyPath);
  });

  test("verifies rotated Line credentials before atomic persistence", async () => {
    const { io } = await fixture();
    await Effect.runPromise(runCliEffect(["client", "init"], io));
    const firstKey = join(io.clientStateRoot, "first.key");
    const secondKey = join(io.clientStateRoot, "second.key");
    await privateKey(firstKey);
    await privateKey(secondKey);
    io.readStdinEffect = () => Effect.succeed("first-bearer");
    await Effect.runPromise(
      runCliEffect(
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
      ),
    );
    io.readStdinEffect = () => Effect.succeed("second-bearer");
    io.verifyLineEffect = (line) =>
      Effect.sync(() => {
        expect(line.remoteBearer).toBe("second-bearer");
        throw new Error("Owner mismatch");
      });
    expect(
      await Effect.runPromise(
        runCliEffect(
          ["client", "line", "update", "jason", "--key", secondKey, "--bearer", "-", "--yes"],
          io,
        ),
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
      ),
    );
    expect(
      await Effect.runPromise(runCliEffect(["gateway", "workspace", "remove", "docs"], io)),
    ).toBe(2);
    expect(output().stderr).toContain("--yes");
    clear();
    expect(await Effect.runPromise(runCliEffect(["client", "line", "add", "--help"], io))).toBe(0);
    expect(output().stdout).toContain("Examples:");
    expect(output().stdout).toContain("remote-client-id");
    clear();
    expect(await Effect.runPromise(runCliEffect(["workspace", "list"], io))).toBe(2);
    expect(output().stderr).toContain("gateway|client");
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
    expect(
      await Effect.runPromise(
        runCliEffect(["gateway", "client", "add", "agent", "--tailcat-key", "-"], io),
      ),
    ).toBe(0);
    expect(validated).toBe("nodekey:stdin");
    clear();
    expect(
      await Effect.runPromise(runCliEffect(["gateway", "client", "list", "--bogus", "value"], io)),
    ).toBe(2);
    expect(output().stderr).toContain("Unknown option --bogus");
    clear();
    expect(await Effect.runPromise(runCliEffect(["client", "line", "list", "extra"], io))).toBe(2);
    expect(output().stderr).toContain("Usage: colleague-line client line list");
  });

  test("rejects malformed Tailcat keys before persisting a remote Client", async () => {
    const { io, output } = await fixture();
    await initGateway(io);
    io.validateTailcatKeyEffect = () =>
      Effect.sync(() => {
        throw new Error("Invalid Tailcat public key");
      });
    expect(
      await Effect.runPromise(
        runCliEffect(["gateway", "client", "add", "agent", "--tailcat-key", "bad"], io),
      ),
    ).toBe(1);
    expect(output().stdout).not.toContain("bearer:");
    expect((await Effect.runPromise(new ConfigStore(io).readEffect())).clients).toEqual([]);
  });

  test("does not mistake offline maintenance for a running Gateway", async () => {
    const { io } = await fixture();
    await initGateway(io);
    io.gatewayReloadTimeoutMs = 5;
    const release = await Effect.runPromise(acquireMaintenanceLockEffect(io.stateRoot));
    try {
      expect(
        await Effect.runPromise(
          runCliEffect(["gateway", "client", "add", "agent", "--tailcat-key", "nodekey:test"], io),
        ),
      ).toBe(0);
    } finally {
      await Effect.runPromise(release);
    }
  });

  test("leaves revoked history for running Gateway to abort before deletion", async () => {
    const { io } = await fixture();
    await initGateway(io);
    await Effect.runPromise(
      runCliEffect(["gateway", "client", "add", "agent", "--tailcat-key", "nodekey:test"], io),
    );
    const sessions = new RuntimeSessionStore(io.stateRoot);
    const session = await Effect.runPromise(sessions.getOrCreateEffect("agent", "docs"));
    const release = await Effect.runPromise(
      acquireProcessLockEffect(join(io.stateRoot, "gateway.lock")),
    );
    try {
      let settled = false;
      const pending = Effect.runPromise(
        runCliEffect(["gateway", "client", "revoke", "agent", "--yes"], io),
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
    await Effect.runPromise(runCliEffect(["client", "init"], io));
    const keyPath = join(io.clientStateRoot, "rejected.key");
    await privateKey(keyPath);
    io.readStdinEffect = () => Effect.succeed("remote-bearer");
    io.verifyLineEffect = () =>
      Effect.sync(() => {
        throw new Error("Owner identity mismatch");
      });
    expect(
      await Effect.runPromise(
        runCliEffect(
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
      ),
    ).toBe(1);
    expect(
      await Effect.runPromise(
        new ClientConfigStore({ configPath: io.clientConfigPath }).listEffect(),
      ),
    ).toEqual([]);
    expect(await Effect.runPromise(runCliEffect(["client", "connect", "owner"], io))).toBe(2);
    expect(await Effect.runPromise(runCliEffect(["client", "profile", "list"], io))).toBe(2);
    expect(output().stderr).toContain("Usage: colleague-line");
  });
});
