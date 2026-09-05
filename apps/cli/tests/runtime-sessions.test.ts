import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { RuntimeSessionStore } from "../src/runtime/sessions";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("RuntimeSessionStore", () => {
  test("persists one Runtime Session ID per Peer and Workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "qujing-sessions-"));
    roots.push(root);
    const firstStore = new RuntimeSessionStore(root);

    const [first, concurrent] = await Promise.all([
      Effect.runPromise(firstStore.getOrCreateEffect("agent", "workspace")),
      Effect.runPromise(firstStore.getOrCreateEffect("agent", "workspace")),
    ]);
    const restored = await Effect.runPromise(
      new RuntimeSessionStore(root).getOrCreateEffect("agent", "workspace"),
    );

    expect(concurrent.id).toBe(first.id);
    expect(restored.id).toBe(first.id);
  });

  test("removes only matching session bindings", async () => {
    const root = await mkdtemp(join(tmpdir(), "qujing-sessions-"));
    roots.push(root);
    const store = new RuntimeSessionStore(root);
    await Effect.runPromise(store.getOrCreateEffect("one", "docs"));
    await Effect.runPromise(store.getOrCreateEffect("one", "code"));
    await Effect.runPromise(store.getOrCreateEffect("two", "docs"));

    const removed = await Effect.runPromise(
      store.matchingEffect((session) => session.peerId === "one"),
    );
    await Promise.all(removed.map((session) => Effect.runPromise(store.removeEffect(session))));

    expect(removed).toHaveLength(2);
    expect(await Effect.runPromise(store.listEffect())).toMatchObject([
      { peerId: "two", workspaceId: "docs" },
    ]);
  });
});
