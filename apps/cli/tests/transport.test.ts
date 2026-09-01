import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectorArgs, createTransportKey, serverArgs } from "../src/transport/process";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

describe("Tailcat transport command boundary", () => {
  test("serves only one Colleague Line port with an explicit allowlist", () => {
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
    const root = await mkdtemp(join(tmpdir(), "colleague-line-transport-process-"));
    roots.push(root);
    const binary = join(root, "fake-transport");
    await writeFile(
      binary,
      '#!/bin/sh\necho \'{"ready":true,"publicKey":"nodekey:test","keyPath":"/tmp/key"}\'\n',
    );
    await chmod(binary, 0o700);
    const started = performance.now();

    expect(await createTransportKey(join(root, "key"), binary)).toEqual({
      publicKey: "nodekey:test",
      keyPath: "/tmp/key",
    });
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
