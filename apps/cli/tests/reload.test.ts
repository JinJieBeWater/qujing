import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentConfigStore } from "../src/agent-config";
import { ConfigStore } from "../src/config";
import {
  acknowledgeAgentReloadEffect,
  acknowledgeNodeReloadEffect,
  waitForAgentReloadEffect,
  waitForNodeReloadEffect,
} from "../src/reload";
import { acquireProcessLockEffect } from "../src/process-lock";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

describe("Node reload acknowledgement", () => {
  test("waits until Node acknowledges the effective config", async () => {
    const root = await mkdtemp(join(tmpdir(), "qujing-reload-"));
    roots.push(root);
    const store = new ConfigStore({
      configPath: join(root, "config.json"),
      stateRoot: join(root, "state"),
    });
    await Effect.runPromise(store.initEffect({ node: { id: "node", name: "Node" } }));
    const release = await Effect.runPromise(
      acquireProcessLockEffect(join(root, "state", "node.lock")),
    );
    const pending = Effect.runPromise(
      waitForNodeReloadEffect(store, join(root, "state"), () => true, 1_000),
    );
    await Bun.sleep(25);
    await Effect.runPromise(
      acknowledgeNodeReloadEffect(
        join(root, "state"),
        await Effect.runPromise(store.readEffectiveEffect()),
      ),
    );

    expect(await pending).toBe(true);
    await Effect.runPromise(release);
  });

  test("returns control for local cleanup if Node stops", async () => {
    const root = await mkdtemp(join(tmpdir(), "qujing-reload-"));
    roots.push(root);
    const store = new ConfigStore({
      configPath: join(root, "config.json"),
      stateRoot: join(root, "state"),
    });
    await Effect.runPromise(store.initEffect({ node: { id: "node", name: "Node" } }));
    expect(
      await Effect.runPromise(waitForNodeReloadEffect(store, join(root, "state"), () => true, 100)),
    ).toBe(false);
  });
});

test("waits until running Agent acknowledges exact config", async () => {
  const root = await mkdtemp(join(tmpdir(), "qujing-agent-reload-"));
  roots.push(root);
  const store = new AgentConfigStore({ configPath: join(root, "agent.json") });
  await Effect.runPromise(store.initEffect());
  const expected = await Effect.runPromise(store.readEffect());
  const release = await Effect.runPromise(
    acquireProcessLockEffect(join(root, "state", "agent.lock")),
  );
  try {
    const pending = Effect.runPromise(
      waitForAgentReloadEffect(store, join(root, "state"), expected, 1_000),
    );
    await Bun.sleep(10);
    await Effect.runPromise(acknowledgeAgentReloadEffect(join(root, "state"), expected));
    expect(await pending).toBe(true);
  } finally {
    await Effect.runPromise(release);
  }
});
