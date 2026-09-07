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
        keyPath: "/state/agent.key",
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
      "/state/agent.key",
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

  test("forces and waits for Connector exit when SIGTERM is ignored", async () => {
    const root = await mkdtemp(join(tmpdir(), "qujing-transport-force-"));
    roots.push(root);
    const binary = join(root, "connector");
    const pidPath = join(root, "pid");
    await writeFile(
      binary,
      `#!${process.execPath}
process.on("SIGTERM", () => {});
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ready") });
await Bun.write(${JSON.stringify(pidPath)}, String(process.pid));
console.log(JSON.stringify({ ready: true, localAddress: "127.0.0.1:" + server.port }));
`,
    );
    await chmod(binary, 0o700);
    const connector = await Effect.runPromise(
      startConnectorEffect(
        {
          serverAddress: "test",
          remotePort: 43110,
          keyPath: "/unused",
          localHost: "127.0.0.1",
          localPort: 0,
        },
        binary,
      ),
    );
    const pid = Number(await Bun.file(pidPath).text());
    const closing = Effect.runPromise(
      Effect.scoped(
        Effect.acquireRelease(Effect.succeed(connector), (resource) =>
          resource.closeEffect().pipe(Effect.orDie),
        ),
      ),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        closing,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Connector did not exit")), 7_000);
        }),
      ]);
      expect(() => process.kill(pid, 0)).toThrow();
      await expect(fetch(`http://${connector.ready.localAddress}`)).rejects.toBeDefined();
    } finally {
      clearTimeout(timer);
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
      }
      await closing;
    }
  }, 10_000);
});
