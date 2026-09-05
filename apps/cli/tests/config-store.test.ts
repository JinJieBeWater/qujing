import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../src/config";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "qujing-test-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const store = new ConfigStore({
    configPath: join(root, "config", "config.json"),
    stateRoot: join(root, "state"),
  });
  await Effect.runPromise(store.initEffect({ node: { id: "jason", name: "Jason" } }));
  return { root, store, workspace };
}

describe("ConfigStore", () => {
  test("registers canonical workspaces idempotently without exposing roots", async () => {
    const { store, workspace } = await fixture();
    const input = { id: "tooling", name: "Tooling", summary: "Runtime tooling", root: workspace };

    await Effect.runPromise(store.addWorkspaceEffect(input));
    await Effect.runPromise(store.addWorkspaceEffect(input));

    expect(await Effect.runPromise(store.listPublicWorkspacesEffect())).toEqual([
      { id: "tooling", name: "Tooling", summary: "Runtime tooling", available: true },
    ]);
    expect(JSON.stringify(await Effect.runPromise(store.readEffect()))).toContain(workspace);
    expect(
      JSON.stringify(await Effect.runPromise(store.listPublicWorkspacesEffect())),
    ).not.toContain(workspace);
  });

  test("rejects conflicting IDs and duplicate canonical roots", async () => {
    const { root, store, workspace } = await fixture();
    const other = join(root, "other");
    await mkdir(other);
    await Effect.runPromise(
      store.addWorkspaceEffect({ id: "one", name: "One", summary: "One", root: workspace }),
    );

    await expect(
      Effect.runPromise(
        store.addWorkspaceEffect({ id: "one", name: "Changed", summary: "One", root: workspace }),
      ),
    ).rejects.toThrow("Workspace ID already exists with different configuration");
    await expect(
      Effect.runPromise(
        store.addWorkspaceEffect({ id: "two", name: "Two", summary: "Two", root: workspace }),
      ),
    ).rejects.toThrow("Workspace root is already registered");
  });

  test("stores only bearer hashes and authenticates active peers", async () => {
    const { root, store } = await fixture();
    const { bearer } = await Effect.runPromise(
      store.addAgentEffect({ id: "agent-one", tailcatKey: "public-key" }),
    );

    expect(await Effect.runPromise(store.authenticateEffect(bearer))).toMatchObject({
      id: "agent-one",
    });
    expect(await Effect.runPromise(store.authenticateEffect("wrong"))).toBeUndefined();
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

    await Effect.runPromise(store.initEffect({ node: { id: "jason", name: "Jason" } }));

    expect((await Effect.runPromise(store.readEffect())).node).toEqual({
      id: "jason",
      name: "Jason",
    });
  });

  test("sets TanStack ACP runtime", async () => {
    const { store } = await fixture();

    await Effect.runPromise(
      store.setRuntimeEffect({
        kind: "tanstack-acp",
        name: "codex",
        model: "test-model",
        command: "agent --acp --model {model} --cwd {cwd}",
        authMode: "host",
        permissionMode: "bypassPermissions",
      }),
    );

    expect((await Effect.runPromise(store.readEffect())).runtime).toMatchObject({
      kind: "tanstack-acp",
      name: "codex",
    });
  });

  test("sets Pi RPC runtime", async () => {
    const { store } = await fixture();

    await Effect.runPromise(
      store.setRuntimeEffect({
        kind: "pi-rpc",
        model: "openai-codex/gpt-5.5",
      }),
    );

    expect((await Effect.runPromise(store.readEffect())).runtime).toMatchObject({
      kind: "pi-rpc",
      model: "openai-codex/gpt-5.5",
    });
  });

  test("rotates credentials and permanently tombstones revoked Peer credential IDs", async () => {
    const { store } = await fixture();
    const original = await Effect.runPromise(
      store.addAgentEffect({ id: "agent", tailcatKey: "old-key" }),
    );
    const rotated = await Effect.runPromise(store.rotateAgentEffect("agent", "new-key"));

    expect(await Effect.runPromise(store.authenticateEffect(original.bearer))).toBeUndefined();
    expect(await Effect.runPromise(store.authenticateEffect(rotated.bearer))).toMatchObject({
      id: "agent",
    });
    expect(await Effect.runPromise(store.revokeAgentEffect("agent"))).toBe(true);
    expect(await Effect.runPromise(store.authenticateEffect(rotated.bearer))).toBeUndefined();
    await expect(
      Effect.runPromise(store.addAgentEffect({ id: "agent", tailcatKey: "third-key" })),
    ).rejects.toThrow("Peer credential ID was revoked and cannot be reused");
  });

  test("permanently tombstones removed workspace IDs", async () => {
    const { store, workspace } = await fixture();
    await Effect.runPromise(
      store.addWorkspaceEffect({ id: "docs", name: "Docs", summary: "Docs", root: workspace }),
    );

    expect(await Effect.runPromise(store.removeWorkspaceEffect("docs"))).toBe(true);
    await expect(
      Effect.runPromise(
        store.addWorkspaceEffect({ id: "docs", name: "Docs", summary: "Docs", root: workspace }),
      ),
    ).rejects.toThrow("Workspace ID was removed and cannot be reused");
  });

  test("fails closed when a crash leaves a tombstoned agent in config", async () => {
    const { root, store } = await fixture();
    const { bearer } = await Effect.runPromise(
      store.addAgentEffect({ id: "agent", tailcatKey: "key" }),
    );
    await writeFile(
      join(root, "state", "tombstones.json"),
      JSON.stringify({ workspaces: [], peers: ["agent"] }),
    );

    expect(await Effect.runPromise(store.authenticateEffect(bearer))).toBeUndefined();
    expect((await Effect.runPromise(store.readEffectiveEffect())).peers).toEqual([]);
    expect(
      await Effect.runPromise(store.hasAgentEffect({ id: "agent", credentialVersion: "revoked" })),
    ).toBe(false);
  });

  test("fails closed when security state is missing", async () => {
    const { root, store } = await fixture();
    const { bearer } = await Effect.runPromise(
      store.addAgentEffect({ id: "agent", tailcatKey: "key" }),
    );
    await rm(join(root, "state", "tombstones.json"));

    await expect(Effect.runPromise(store.authenticateEffect(bearer))).rejects.toThrow(
      "Security state file not found",
    );
  });

  test("cannot rotate a agent concurrently with revocation", async () => {
    const { store } = await fixture();
    const original = await Effect.runPromise(
      store.addAgentEffect({ id: "agent", tailcatKey: "key" }),
    );
    const outcomes = await Promise.allSettled([
      Effect.runPromise(store.rotateAgentEffect("agent", "new-key")),
      Effect.runPromise(store.revokeAgentEffect("agent")),
    ]);
    const rotated = outcomes[0].status === "fulfilled" ? outcomes[0].value.bearer : undefined;

    expect(await Effect.runPromise(store.authenticateEffect(original.bearer))).toBeUndefined();
    if (rotated) expect(await Effect.runPromise(store.authenticateEffect(rotated))).toBeUndefined();
    expect(
      await Effect.runPromise(store.hasAgentEffect({ id: "agent", credentialVersion: "revoked" })),
    ).toBe(false);
  });
});
