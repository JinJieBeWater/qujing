import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  purgeClientRuntimeSessionsEffect,
  purgeRemovedRuntimeSessionsEffect,
} from "../src/runtime/cleanup";
import { RuntimeSessionStore } from "../src/runtime/sessions";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("runtime session cleanup", () => {
  test("removes bindings for absent Clients and Workspaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "qujing-cleanup-"));
    roots.push(root);
    const store = new RuntimeSessionStore(root);
    const keep = await Effect.runPromise(store.getOrCreateEffect("active", "docs"));
    const removedClient = await Effect.runPromise(store.getOrCreateEffect("revoked", "docs"));
    const removedWorkspace = await Effect.runPromise(store.getOrCreateEffect("active", "removed"));

    const removed = await Effect.runPromise(
      purgeRemovedRuntimeSessionsEffect({ clientIds: ["active"], workspaceIds: ["docs"] }, store),
    );

    expect(removed.map(({ id }) => id).sort()).toEqual(
      [removedClient.id, removedWorkspace.id].sort(),
    );
    expect((await Effect.runPromise(store.listEffect())).map(({ id }) => id)).toEqual([keep.id]);
  });

  test("removes bindings without deleting Pi-owned session archives", async () => {
    const root = await mkdtemp(join(tmpdir(), "qujing-cleanup-"));
    roots.push(root);
    const store = new RuntimeSessionStore(root);
    await Effect.runPromise(store.getOrCreateEffect("client", "docs"));
    const archive = join(root, "owner-global-pi-session.jsonl");
    await writeFile(archive, "history");

    await Effect.runPromise(purgeClientRuntimeSessionsEffect("client", store));

    expect(await Effect.runPromise(store.listEffect())).toEqual([]);
    expect(await Bun.file(archive).text()).toBe("history");
  });
});
