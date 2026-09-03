import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientConfigStore } from "../src/client-config";
import { ConfigStore } from "../src/config";
import {
  acknowledgeClientReloadEffect,
  acknowledgeGatewayReloadEffect,
  waitForClientReloadEffect,
  waitForGatewayReloadEffect,
} from "../src/gateway-reload";
import { acquireProcessLockEffect } from "../src/process-lock";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

describe("Gateway reload acknowledgement", () => {
  test("waits until Gateway acknowledges the effective config", async () => {
    const root = await mkdtemp(join(tmpdir(), "qujing-reload-"));
    roots.push(root);
    const store = new ConfigStore({
      configPath: join(root, "config.json"),
      stateRoot: join(root, "state"),
    });
    await Effect.runPromise(store.initEffect({ owner: { id: "owner", name: "Owner" } }));
    const release = await Effect.runPromise(
      acquireProcessLockEffect(join(root, "state", "gateway.lock")),
    );
    const pending = Effect.runPromise(
      waitForGatewayReloadEffect(store, join(root, "state"), () => true, 1_000),
    );
    await Bun.sleep(25);
    await Effect.runPromise(
      acknowledgeGatewayReloadEffect(
        join(root, "state"),
        await Effect.runPromise(store.readEffectiveEffect()),
      ),
    );

    expect(await pending).toBe(true);
    await Effect.runPromise(release);
  });

  test("returns control for local cleanup if Gateway stops", async () => {
    const root = await mkdtemp(join(tmpdir(), "qujing-reload-"));
    roots.push(root);
    const store = new ConfigStore({
      configPath: join(root, "config.json"),
      stateRoot: join(root, "state"),
    });
    await Effect.runPromise(store.initEffect({ owner: { id: "owner", name: "Owner" } }));
    expect(
      await Effect.runPromise(
        waitForGatewayReloadEffect(store, join(root, "state"), () => true, 100),
      ),
    ).toBe(false);
  });
});

test("waits until running Client acknowledges exact config", async () => {
  const root = await mkdtemp(join(tmpdir(), "qujing-client-reload-"));
  roots.push(root);
  const store = new ClientConfigStore({ configPath: join(root, "client.json") });
  await Effect.runPromise(store.initEffect());
  const expected = await Effect.runPromise(store.readEffect());
  const release = await Effect.runPromise(
    acquireProcessLockEffect(join(root, "state", "client.lock")),
  );
  try {
    const pending = Effect.runPromise(
      waitForClientReloadEffect(store, join(root, "state"), expected, 1_000),
    );
    await Bun.sleep(10);
    await Effect.runPromise(acknowledgeClientReloadEffect(join(root, "state"), expected));
    expect(await pending).toBe(true);
  } finally {
    await Effect.runPromise(release);
  }
});
