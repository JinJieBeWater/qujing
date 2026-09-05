import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig, PeerConfig } from "../src/agent-config";
import { Effect } from "effect";
import { requestPeerRetirementEffect } from "../src/agent-control";

test("removes stale acknowledgement before publishing a retirement request", async () => {
  const root = await mkdtemp(join(tmpdir(), "qujing-agent-control-"));
  const now = new Date().toISOString();
  const peer: PeerConfig = {
    id: "peer",
    expectedNodeId: "node",
    remoteAgentId: "remote-agent",
    serverAddress: "tailcat-server",
    remotePort: 43_110,
    keyPath: "/private/key",
    remoteBearer: "secret",
    createdAt: now,
    updatedAt: now,
  };
  const config: AgentConfig = {
    version: 1,
    server: { host: "127.0.0.1", port: 43_111 },
    localBearerHash: "0".repeat(64),
    peers: [peer],
  };
  const acknowledgement = join(root, "agent-peer-retirement-ack.json");
  const requestPath = join(root, "agent-peer-retirement.json");

  try {
    await writeFile(acknowledgement, "stale");
    const request = await Effect.runPromise(requestPeerRetirementEffect(root, config, peer));

    expect(await Bun.file(acknowledgement).exists()).toBe(false);
    expect(JSON.parse(await readFile(requestPath, "utf8"))).toEqual(request);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
