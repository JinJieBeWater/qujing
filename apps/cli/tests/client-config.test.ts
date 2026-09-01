import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientConfigStore, LOCAL_CLIENT_ID } from "../src/client-config";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "colleague-line-client-"));
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
    const first = await store.init({ port: 43111 });
    expect(first.initialized).toBe(true);
    if (!first.initialized) throw new Error("missing bearer");
    expect(await store.authenticateLocal(first.bearer)).toEqual({
      id: LOCAL_CLIENT_ID,
      credentialVersion: (await store.read()).localBearerHash,
    });
    expect(await store.init()).toEqual({ initialized: false, alreadyInitialized: true });
    await expect(store.init({ port: 43112 })).rejects.toThrow("different port");
    expect(await readFile(path, "utf8")).not.toContain(first.bearer);
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, "config"))).mode & 0o777).toBe(0o700);
    }
  });

  test("redacts lists, updates credentials, removes, and reuses IDs", async () => {
    const { key, store } = await fixture();
    await store.init();
    await store.add(line(key));
    expect(await store.list()).toEqual([
      expect.objectContaining({ id: "line", remotePort: 43110 }),
    ]);
    const listed = JSON.stringify(await store.list());
    expect(listed).not.toContain("remote-secret");
    expect(listed).not.toContain(key);
    expect(listed).not.toContain("tailcat");
    await expect(store.add({ ...line(key), serverAddress: "changed" })).rejects.toThrow(
      "different configuration",
    );
    const next = `${key}-next`;
    await writeFile(next, "key-next");
    await chmod(next, 0o600);
    await store.updateCredentials("line", { keyPath: next, remoteBearer: "next-secret" });
    expect((await store.get("line"))?.remoteBearer).toBe("next-secret");
    expect(await store.remove("line")).toBe(true);
    expect(await store.remove("line")).toBe(false);
    await store.add(line(key));
  });

  test("rejects missing, permissive, and shared Line credentials", async () => {
    const { root, key, store } = await fixture();
    await store.init();
    await store.add(line(key, "one", "bearer-one"));
    const other = join(root, "other-key");
    await writeFile(other, "key-two");
    await chmod(other, 0o600);

    await expect(store.add(line(other, "two", "bearer-one"))).rejects.toThrow(
      "distinct remote bearer",
    );
    const copied = join(root, "copied-key");
    await writeFile(copied, "key-one");
    await chmod(copied, 0o600);
    await expect(store.add(line(copied, "two", "bearer-two"))).rejects.toThrow(
      "distinct Tailcat key",
    );
    await store.add(line(other, "two", "bearer-two"));
    await expect(
      store.updateCredentials("two", { keyPath: other, remoteBearer: "bearer-one" }),
    ).rejects.toThrow("distinct remote bearer");
    await expect(store.add(line(join(root, "missing"), "three", "three"))).rejects.toThrow(
      "not found",
    );
    if (process.platform !== "win32") {
      await chmod(other, 0o644);
      await expect(
        store.updateCredentials("two", { keyPath: other, remoteBearer: "new" }),
      ).rejects.toThrow("permissions");
    }
  });
});
