import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeSessionStore } from "../src/runtime/sessions";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("RuntimeSessionStore", () => {
  test("persists one Pi session ID per Client and Workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "colleague-line-sessions-"));
    roots.push(root);
    const firstStore = new RuntimeSessionStore(root);

    const [first, concurrent] = await Promise.all([
      firstStore.getOrCreate("client", "workspace"),
      firstStore.getOrCreate("client", "workspace"),
    ]);
    const restored = await new RuntimeSessionStore(root).getOrCreate("client", "workspace");

    expect(concurrent.id).toBe(first.id);
    expect(restored.id).toBe(first.id);
  });

  test("removes only matching session bindings", async () => {
    const root = await mkdtemp(join(tmpdir(), "colleague-line-sessions-"));
    roots.push(root);
    const store = new RuntimeSessionStore(root);
    await store.getOrCreate("one", "docs");
    await store.getOrCreate("one", "code");
    await store.getOrCreate("two", "docs");

    const removed = await store.matching((session) => session.clientId === "one");
    await Promise.all(removed.map((session) => store.remove(session)));

    expect(removed).toHaveLength(2);
    expect(await store.list()).toMatchObject([{ clientId: "two", workspaceId: "docs" }]);
  });
});
