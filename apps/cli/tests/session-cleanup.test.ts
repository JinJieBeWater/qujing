import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { purgeClientRuntimeSessions, purgeRemovedRuntimeSessions } from "../src/runtime/cleanup";
import { RuntimeSessionStore } from "../src/runtime/sessions";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("runtime session cleanup", () => {
  test("removes bindings for absent Clients and Workspaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "colleague-line-cleanup-"));
    roots.push(root);
    const store = new RuntimeSessionStore(root);
    const keep = await store.getOrCreate("active", "docs");
    const removedClient = await store.getOrCreate("revoked", "docs");
    const removedWorkspace = await store.getOrCreate("active", "removed");

    const removed = await purgeRemovedRuntimeSessions(
      { clientIds: ["active"], workspaceIds: ["docs"] },
      store,
    );

    expect(removed.map(({ id }) => id).sort()).toEqual(
      [removedClient.id, removedWorkspace.id].sort(),
    );
    expect((await store.list()).map(({ id }) => id)).toEqual([keep.id]);
  });

  test("removes bindings without deleting Pi-owned session archives", async () => {
    const root = await mkdtemp(join(tmpdir(), "colleague-line-cleanup-"));
    roots.push(root);
    const store = new RuntimeSessionStore(root);
    await store.getOrCreate("client", "docs");
    const archive = join(root, "owner-global-pi-session.jsonl");
    await writeFile(archive, "history");

    await purgeClientRuntimeSessions("client", store);

    expect(await store.list()).toEqual([]);
    expect(await Bun.file(archive).text()).toBe("history");
  });
});
