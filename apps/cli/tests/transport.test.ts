import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  connectorArgs,
  createTransportKeyEffect,
  serverArgs,
  startConnectorEffect,
} from "../src/transport/process";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

describe("Tailcat transport command boundary", () => {
  test("serves only one Qujing port with an explicit allowlist", () => {
    expect(
      serverArgs({
        keyPath: "/state/server.key",
        port: 43_110,
        allowedKeys: ["nodekey:a", "nodekey:b"],
      }),
    ).toEqual([
      "serve",
      "--key",
      "/state/server.key",
      "--port",
      "43110",
      "--allow",
      "nodekey:a",
      "--allow",
      "nodekey:b",
    ]);
    expect(serverArgs({ keyPath: "/state/server.key", port: 43_110, allowedKeys: [] })).toContain(
      "none",
    );
  });

  test("connects through an ephemeral loopback listener", () => {
    expect(
      connectorArgs({
        serverAddress: "tc-token",
        remotePort: 43_110,
        keyPath: "/state/client.key",
        localHost: "127.0.0.1",
        localPort: 0,
      }),
    ).toEqual([
      "connect",
      "--server",
      "tc-token",
      "--port",
      "43110",
      "--key",
      "/state/client.key",
      "--listen",
      "127.0.0.1:0",
    ]);
  });

  test("clears readiness timeout after a short command exits", async () => {
    const root = await mkdtemp(join(tmpdir(), "qujing-transport-process-"));
    roots.push(root);
    const binary = join(root, "fake-transport");
    await writeFile(
      binary,
      '#!/bin/sh\necho \'{"ready":true,"publicKey":"nodekey:test","keyPath":"/tmp/key"}\'\n',
    );
    await chmod(binary, 0o700);
    const started = performance.now();

    expect(await Effect.runPromise(createTransportKeyEffect(join(root, "key"), binary))).toEqual({
      publicKey: "nodekey:test",
      keyPath: "/tmp/key",
    });
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  test("closes a process still waiting for readiness when caller aborts", async () => {
    const root = await mkdtemp(join(tmpdir(), "qujing-transport-process-"));
    roots.push(root);
    const binary = join(root, "fake-transport");
    const pid = join(root, "pid");
    await writeFile(binary, `#!/bin/sh\necho $$ > "${pid}"\nwhile :; do sleep 1; done\n`);
    await chmod(binary, 0o700);
    const controller = new AbortController();
    const pending = Effect.runPromise(
      startConnectorEffect(
        {
          serverAddress: "tailcat",
          remotePort: 43110,
          keyPath: "/key",
          localHost: "127.0.0.1",
          localPort: 0,
        },
        binary,
        controller.signal,
      ),
    );
    for (let retry = 0; retry < 100 && !(await Bun.file(pid).exists()); retry++)
      await Bun.sleep(10);
    expect(await Bun.file(pid).exists()).toBe(true);
    const started = performance.now();
    controller.abort(new DOMException("Aborted", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(performance.now() - started).toBeLessThan(1_000);
    const childPid = Number((await Bun.file(pid).text()).trim());
    let alive = true;
    for (let retry = 0; retry < 20 && alive; retry++) {
      await Bun.sleep(10);
      try {
        process.kill(childPid, 0);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });
});
