import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientConfigStore } from "../src/client-config";
import { ConfigStore } from "../src/config";
import {
  acknowledgeClientReload,
  acknowledgeGatewayReload,
  waitForClientReload,
  waitForGatewayReload,
} from "../src/gateway-reload";
import { acquireProcessLock } from "../src/process-lock";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

describe("Gateway reload acknowledgement", () => {
  test("waits until Gateway acknowledges the effective config", async () => {
    const root = await mkdtemp(join(tmpdir(), "colleague-line-reload-"));
    roots.push(root);
    const store = new ConfigStore({
      configPath: join(root, "config.json"),
      stateRoot: join(root, "state"),
    });
    await store.init({ owner: { id: "owner", name: "Owner" } });
    const release = await acquireProcessLock(join(root, "state", "gateway.lock"));
    const pending = waitForGatewayReload(store, join(root, "state"), () => true, 1_000);
    await Bun.sleep(25);
    await acknowledgeGatewayReload(join(root, "state"), await store.readEffective());

    expect(await pending).toBe(true);
    await release();
  });

  test("returns control for local cleanup if Gateway stops", async () => {
    const root = await mkdtemp(join(tmpdir(), "colleague-line-reload-"));
    roots.push(root);
    const store = new ConfigStore({
      configPath: join(root, "config.json"),
      stateRoot: join(root, "state"),
    });
    await store.init({ owner: { id: "owner", name: "Owner" } });
    expect(await waitForGatewayReload(store, join(root, "state"), () => true, 100)).toBe(false);
  });
});

test("waits until running Client acknowledges exact config", async () => {
  const root = await mkdtemp(join(tmpdir(), "colleague-line-client-reload-"));
  roots.push(root);
  const store = new ClientConfigStore({ configPath: join(root, "client.json") });
  await store.init();
  const expected = await store.read();
  const release = await acquireProcessLock(join(root, "state", "client.lock"));
  try {
    const pending = waitForClientReload(store, join(root, "state"), expected, 1_000);
    await Bun.sleep(10);
    await acknowledgeClientReload(join(root, "state"), expected);
    expect(await pending).toBe(true);
  } finally {
    await release();
  }
});
