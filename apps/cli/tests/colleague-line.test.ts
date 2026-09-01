import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createColleagueLine } from "../src/colleague-line";
import { ConfigStore } from "../src/config";
import { ColleagueLineError } from "../src/errors";

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
  await config.init({ owner: { id: "owner", name: "Owner" } });
  await config.addWorkspace({
    id: "docs",
    name: "Docs",
    summary: "Product docs",
    root: workspaceRoot,
  });
  const first = await config.addClient({ id: "first", tailcatKey: "first-key" });
  const second = await config.addClient({ id: "second", tailcatKey: "second-key" });
  const calls: Array<{ client: string; workspace: string; question: string }> = [];
  const app = createColleagueLine({
    config,
    answer: async ({ client, workspaceId, question }) => {
      calls.push({ client: client.id, workspace: workspaceId, question });
      return `answer:${question}`;
    },
  });
  return {
    app,
    calls,
    first: (await config.authenticate(first.bearer))!,
    second: (await config.authenticate(second.bearer))!,
  };
}

describe("ColleagueLine core", () => {
  test("lists only public owner and workspace metadata for active clients", async () => {
    const { app, first } = await fixture();

    expect(await app.listWorkspaces(first)).toEqual({
      owner: { id: "owner", name: "Owner" },
      workspaces: [{ id: "docs", name: "Docs", summary: "Product docs", available: true }],
    });
    await expect(
      app.listWorkspaces({ id: "revoked", credentialVersion: "revoked" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  test("passes authenticated Client and selected Workspace to runtime coordination", async () => {
    const { app, calls, first, second } = await fixture();

    await app.ask(
      { client: first, workspace: "docs", question: "one" },
      new AbortController().signal,
    );
    await app.ask(
      { client: first, workspace: "docs", question: "two" },
      new AbortController().signal,
    );
    await app.ask(
      { client: second, workspace: "docs", question: "three" },
      new AbortController().signal,
    );

    expect(calls).toEqual([
      { client: "first", workspace: "docs", question: "one" },
      { client: "first", workspace: "docs", question: "two" },
      { client: "second", workspace: "docs", question: "three" },
    ]);
  });

  test("validates questions and selected workspaces before runtime", async () => {
    const { app, first } = await fixture();
    const signal = new AbortController().signal;

    await expect(
      app.ask({ client: first, workspace: "docs", question: "" }, signal),
    ).rejects.toEqual(new ColleagueLineError("INVALID_QUESTION", "Question must not be empty"));
    await expect(
      app.ask({ client: first, workspace: "missing", question: "hello" }, signal),
    ).rejects.toMatchObject({
      code: "WORKSPACE_NOT_FOUND",
    });
  });
});
