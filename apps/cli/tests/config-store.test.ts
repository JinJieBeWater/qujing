import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../src/config";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "colleague-line-test-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const store = new ConfigStore({
    configPath: join(root, "config", "config.json"),
    stateRoot: join(root, "state"),
  });
  await store.init({ owner: { id: "jason", name: "Jason" } });
  return { root, store, workspace };
}

describe("ConfigStore", () => {
  test("registers canonical workspaces idempotently without exposing roots", async () => {
    const { store, workspace } = await fixture();
    const input = { id: "tooling", name: "Tooling", summary: "Pi tooling", root: workspace };

    await store.addWorkspace(input);
    await store.addWorkspace(input);

    expect(await store.listPublicWorkspaces()).toEqual([
      { id: "tooling", name: "Tooling", summary: "Pi tooling", available: true },
    ]);
    expect(JSON.stringify(await store.read())).toContain(workspace);
    expect(JSON.stringify(await store.listPublicWorkspaces())).not.toContain(workspace);
  });

  test("rejects conflicting IDs and duplicate canonical roots", async () => {
    const { root, store, workspace } = await fixture();
    const other = join(root, "other");
    await mkdir(other);
    await store.addWorkspace({ id: "one", name: "One", summary: "One", root: workspace });

    await expect(
      store.addWorkspace({ id: "one", name: "Changed", summary: "One", root: workspace }),
    ).rejects.toThrow("Workspace ID already exists with different configuration");
    await expect(
      store.addWorkspace({ id: "two", name: "Two", summary: "Two", root: workspace }),
    ).rejects.toThrow("Workspace root is already registered");
  });

  test("stores only bearer hashes and authenticates active clients", async () => {
    const { root, store } = await fixture();
    const { bearer } = await store.addClient({ id: "agent-one", tailcatKey: "public-key" });

    expect(await store.authenticate(bearer)).toMatchObject({ id: "agent-one" });
    expect(await store.authenticate("wrong")).toBeUndefined();
    const configText = await readFile(join(root, "config", "config.json"), "utf8");
    expect(configText).not.toContain(bearer);
    expect(configText).toContain("bearerHash");
  });

  test("writes private directories and files", async () => {
    const { root } = await fixture();
    expect((await stat(join(root, "config"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, "config", "config.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, "state"))).mode & 0o777).toBe(0o700);
  });

  test("repeats identical initialization as an idempotent no-op", async () => {
    const { store } = await fixture();

    await store.init({ owner: { id: "jason", name: "Jason" } });

    expect((await store.read()).owner).toEqual({ id: "jason", name: "Jason" });
  });

  test("rotates credentials and permanently tombstones revoked client IDs", async () => {
    const { store } = await fixture();
    const original = await store.addClient({ id: "agent", tailcatKey: "old-key" });
    const rotated = await store.rotateClient("agent", "new-key");

    expect(await store.authenticate(original.bearer)).toBeUndefined();
    expect(await store.authenticate(rotated.bearer)).toMatchObject({ id: "agent" });
    expect(await store.revokeClient("agent")).toBe(true);
    expect(await store.authenticate(rotated.bearer)).toBeUndefined();
    await expect(store.addClient({ id: "agent", tailcatKey: "third-key" })).rejects.toThrow(
      "Client ID was revoked and cannot be reused",
    );
  });

  test("permanently tombstones removed workspace IDs", async () => {
    const { store, workspace } = await fixture();
    await store.addWorkspace({ id: "docs", name: "Docs", summary: "Docs", root: workspace });

    expect(await store.removeWorkspace("docs")).toBe(true);
    await expect(
      store.addWorkspace({ id: "docs", name: "Docs", summary: "Docs", root: workspace }),
    ).rejects.toThrow("Workspace ID was removed and cannot be reused");
  });

  test("fails closed when a crash leaves a tombstoned client in config", async () => {
    const { root, store } = await fixture();
    const { bearer } = await store.addClient({ id: "agent", tailcatKey: "key" });
    await writeFile(
      join(root, "state", "tombstones.json"),
      JSON.stringify({ workspaces: [], clients: ["agent"] }),
    );

    expect(await store.authenticate(bearer)).toBeUndefined();
    expect((await store.readEffective()).clients).toEqual([]);
    expect(await store.hasClient({ id: "agent", credentialVersion: "revoked" })).toBe(false);
  });

  test("fails closed when security state is missing", async () => {
    const { root, store } = await fixture();
    const { bearer } = await store.addClient({ id: "agent", tailcatKey: "key" });
    await rm(join(root, "state", "tombstones.json"));

    await expect(store.authenticate(bearer)).rejects.toThrow("Security state file not found");
  });

  test("cannot rotate a client concurrently with revocation", async () => {
    const { store } = await fixture();
    const original = await store.addClient({ id: "agent", tailcatKey: "key" });
    const outcomes = await Promise.allSettled([
      store.rotateClient("agent", "new-key"),
      store.revokeClient("agent"),
    ]);
    const rotated = outcomes[0].status === "fulfilled" ? outcomes[0].value.bearer : undefined;

    expect(await store.authenticate(original.bearer)).toBeUndefined();
    if (rotated) expect(await store.authenticate(rotated)).toBeUndefined();
    expect(await store.hasClient({ id: "agent", credentialVersion: "revoked" })).toBe(false);
  });
});
