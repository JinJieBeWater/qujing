import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientConfigStore, LOCAL_CLIENT_ID } from "../src/client-config";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "qujing-client-"));
  roots.push(root);
  const key = join(root, "key");
  await writeFile(key, "key-one");
  await chmod(key, 0o600);
  const path = join(root, "config", "client.json");
  const store = new ClientConfigStore({ configPath: path });
  return { root, path, key, store };
}
const line = (keyPath: string, id = "line", remoteBearer = "remote-secret") => ({
  id,
  expectedOwnerId: `owner-${id}`,
  remoteClientId: `remote-${id}`,
  serverAddress: `tailcat-${id}`,
  remotePort: 43110,
  keyPath,
  remoteBearer,
});

describe("ClientConfigStore", () => {
  test("stores local bearer hash only, reveals it once, and writes private state", async () => {
    const { root, path, store } = await fixture();
    const first = await Effect.runPromise(store.initEffect({ port: 43111 }));
    expect(first.initialized).toBe(true);
    if (!first.initialized) throw new Error("missing bearer");
    expect(await Effect.runPromise(store.authenticateLocalEffect(first.bearer))).toEqual({
      id: LOCAL_CLIENT_ID,
      credentialVersion: (await Effect.runPromise(store.readEffect())).localBearerHash,
    });
    expect(await Effect.runPromise(store.initEffect())).toEqual({
      initialized: false,
      alreadyInitialized: true,
    });
    await expect(Effect.runPromise(store.initEffect({ port: 43112 }))).rejects.toThrow(
      "different port",
    );
    expect(await readFile(path, "utf8")).not.toContain(first.bearer);
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, "config"))).mode & 0o777).toBe(0o700);
    }
  });

  test("redacts lists, updates credentials, removes, and reuses IDs", async () => {
    const { key, store } = await fixture();
    await Effect.runPromise(store.initEffect());
    await Effect.runPromise(store.addEffect(line(key)));
    expect(await Effect.runPromise(store.listEffect())).toEqual([
      expect.objectContaining({ id: "line", remotePort: 43110 }),
    ]);
    const listed = JSON.stringify(await Effect.runPromise(store.listEffect()));
    expect(listed).not.toContain("remote-secret");
    expect(listed).not.toContain(key);
    expect(listed).not.toContain("tailcat");
    await expect(
      Effect.runPromise(store.addEffect({ ...line(key), serverAddress: "changed" })),
    ).rejects.toThrow("different configuration");
    const next = `${key}-next`;
    await writeFile(next, "key-next");
    await chmod(next, 0o600);
    await Effect.runPromise(
      store.updateCredentialsEffect("line", { keyPath: next, remoteBearer: "next-secret" }),
    );
    expect((await Effect.runPromise(store.getEffect("line")))?.remoteBearer).toBe("next-secret");
    expect(await Effect.runPromise(store.removeEffect("line"))).toBe(true);
    expect(await Effect.runPromise(store.removeEffect("line"))).toBe(false);
    await Effect.runPromise(store.addEffect(line(key)));
  });

  test("rejects missing, permissive, and shared Line credentials", async () => {
    const { root, key, store } = await fixture();
    await Effect.runPromise(store.initEffect());
    await Effect.runPromise(store.addEffect(line(key, "one", "bearer-one")));
    const other = join(root, "other-key");
    await writeFile(other, "key-two");
    await chmod(other, 0o600);

    await expect(
      Effect.runPromise(store.addEffect(line(other, "two", "bearer-one"))),
    ).rejects.toThrow("distinct remote bearer");
    const copied = join(root, "copied-key");
    await writeFile(copied, "key-one");
    await chmod(copied, 0o600);
    await expect(
      Effect.runPromise(store.addEffect(line(copied, "two", "bearer-two"))),
    ).rejects.toThrow("distinct Tailcat key");
    await Effect.runPromise(store.addEffect(line(other, "two", "bearer-two")));
    await expect(
      Effect.runPromise(
        store.updateCredentialsEffect("two", { keyPath: other, remoteBearer: "bearer-one" }),
      ),
    ).rejects.toThrow("distinct remote bearer");
    await expect(
      Effect.runPromise(store.addEffect(line(join(root, "missing"), "three", "three"))),
    ).rejects.toThrow("not found");
    if (process.platform !== "win32") {
      await chmod(other, 0o644);
      await expect(
        Effect.runPromise(
          store.updateCredentialsEffect("two", { keyPath: other, remoteBearer: "new" }),
        ),
      ).rejects.toThrow("permissions");
    }
  });
});
