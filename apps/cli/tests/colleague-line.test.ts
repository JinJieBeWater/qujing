import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createColleagueLine } from "../src/colleague-line";
import { ConfigStore } from "../src/config";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "colleague-line-core-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);
  const config = new ConfigStore({
    configPath: join(root, "config.json"),
    stateRoot: join(root, "state"),
  });
  await Effect.runPromise(config.initEffect({ owner: { id: "owner", name: "Owner" } }));
  await Effect.runPromise(
    config.addWorkspaceEffect({
      id: "docs",
      name: "Docs",
      summary: "Product docs",
      root: workspaceRoot,
    }),
  );
  const first = await Effect.runPromise(
    config.addClientEffect({
      id: "first",
      tailcatKey: "first-key",
    }),
  );
  const second = await Effect.runPromise(
    config.addClientEffect({
      id: "second",
      tailcatKey: "second-key",
    }),
  );
  const calls: Array<{ client: string; workspace: string; question: string }> = [];
  const app = createColleagueLine({
    config,
    coordinator: {
      answerEffect: ({ client, workspaceId, question }) =>
        Effect.sync(() => {
          calls.push({ client: client.id, workspace: workspaceId, question });
          return `answer:${question}`;
        }),
    },
  });
  return {
    app,
    calls,
    first: (await Effect.runPromise(config.authenticateEffect(first.bearer)))!,
    second: (await Effect.runPromise(config.authenticateEffect(second.bearer)))!,
  };
}

describe("ColleagueLine core", () => {
  test("lists only public owner and workspace metadata for active clients", async () => {
    const { app, first } = await fixture();

    expect(await Effect.runPromise(app.listWorkspacesEffect(first))).toEqual({
      owner: { id: "owner", name: "Owner" },
      workspaces: [{ id: "docs", name: "Docs", summary: "Product docs", available: true }],
    });
    await expect(
      Effect.runPromise(app.listWorkspacesEffect({ id: "revoked", credentialVersion: "revoked" })),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  test("passes authenticated Client and selected Workspace to runtime coordination", async () => {
    const { app, calls, first, second } = await fixture();

    await Effect.runPromise(
      app.askEffect(
        { client: first, workspace: "docs", question: "one" },
        new AbortController().signal,
      ),
    );
    await Effect.runPromise(
      app.askEffect(
        { client: first, workspace: "docs", question: "two" },
        new AbortController().signal,
      ),
    );
    await Effect.runPromise(
      app.askEffect(
        { client: second, workspace: "docs", question: "three" },
        new AbortController().signal,
      ),
    );

    expect(calls).toEqual([
      { client: "first", workspace: "docs", question: "one" },
      { client: "first", workspace: "docs", question: "two" },
      { client: "second", workspace: "docs", question: "three" },
    ]);
  });
});
