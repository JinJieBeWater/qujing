import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientConfig, LineConfig } from "../src/client-config";
import { Effect } from "effect";
import { requestClientLineRetirementEffect } from "../src/client-control";

test("removes stale acknowledgement before publishing a retirement request", async () => {
  const root = await mkdtemp(join(tmpdir(), "qujing-client-control-"));
  const now = new Date().toISOString();
  const line: LineConfig = {
    id: "line",
    expectedOwnerId: "owner",
    remoteClientId: "remote-client",
    serverAddress: "tailcat-server",
    remotePort: 43_110,
    keyPath: "/private/key",
    remoteBearer: "secret",
    createdAt: now,
    updatedAt: now,
  };
  const config: ClientConfig = {
    version: 1,
    server: { host: "127.0.0.1", port: 43_111 },
    localBearerHash: "0".repeat(64),
    lines: [line],
  };
  const acknowledgement = join(root, "client-line-retirement-ack.json");
  const requestPath = join(root, "client-line-retirement.json");

  try {
    await writeFile(acknowledgement, "stale");
    const request = await Effect.runPromise(requestClientLineRetirementEffect(root, config, line));

    expect(await Bun.file(acknowledgement).exists()).toBe(false);
    expect(JSON.parse(await readFile(requestPath, "utf8"))).toEqual(request);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
