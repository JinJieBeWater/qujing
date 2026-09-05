import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { chmod, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../src/config";
import { runDoctorEffect } from "../src/doctor";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "qujing-doctor-"));
  roots.push(root);
  const paths = {
    configPath: join(root, "config", "config.json"),
    stateRoot: join(root, "state"),
    transportBinary: join(root, "transport"),
  };
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await Bun.write(paths.transportBinary, "binary");
  await chmod(paths.transportBinary, 0o700);
  const config = new ConfigStore(paths);
  await Effect.runPromise(config.initEffect({ node: { id: "node", name: "Node" }, port: 43_199 }));
  await Effect.runPromise(
    config.addWorkspaceEffect({ id: "docs", name: "Docs", summary: "Docs", root: workspace }),
  );
  return { root, paths, workspace };
}

describe("doctor", () => {
  test("checks node config, Runtime, workspace, port, and transport without prompting", async () => {
    const { paths } = await fixture();
    await Effect.runPromise(
      new ConfigStore(paths).setRuntimeEffect({
        kind: "tanstack-acp",
        name: "codex",
        model: "test-model",
        command: "agent --acp --model {model} --cwd {cwd}",
      }),
    );
    let checkedExecutable: string | undefined;
    const report = await Effect.runPromise(
      runDoctorEffect(paths, {
        checkExecutable: (binary) =>
          Effect.sync(() => {
            checkedExecutable = binary;
            return true;
          }),
        checkPort: () => Effect.succeed(true),
      }),
    );

    expect(report.ok).toBe(true);
    expect(checkedExecutable).toBe("agent");
    expect(report.checks.map((check) => check.name)).toEqual(
      expect.arrayContaining([
        "config",
        "permissions",
        "runtime",
        "workspace:docs",
        "port",
        "transport",
      ]),
    );
    expect(report.checks.find((check) => check.name === "tailcat-state")?.status).toBe("warning");
  });

  test("fails on unsafe permissions and unavailable workspaces", async () => {
    const { paths, workspace } = await fixture();
    await chmod(paths.configPath, 0o644);
    await rm(workspace, { recursive: true });
    const report = await Effect.runPromise(
      runDoctorEffect(paths, {
        checkPort: () => Effect.succeed(true),
      }),
    );

    expect(report.ok).toBe(false);
    expect(
      report.checks.filter((check) => check.status === "error").map((check) => check.name),
    ).toEqual(expect.arrayContaining(["permissions", "workspace:docs"]));
  });

  test("checks TanStack ACP runtime", async () => {
    const { paths } = await fixture();
    let checkedExecutable: string | undefined;
    await Effect.runPromise(
      new ConfigStore(paths).setRuntimeEffect({
        kind: "tanstack-acp",
        name: "codex",
        model: "test-model",
        command: "agent --acp --model {model} --cwd {cwd}",
      }),
    );

    const report = await Effect.runPromise(
      runDoctorEffect(paths, {
        checkExecutable: (binary) =>
          Effect.sync(() => {
            checkedExecutable = binary;
            return true;
          }),
        checkPort: () => Effect.succeed(true),
      }),
    );

    expect(checkedExecutable).toBe("agent");
    expect(report.checks.find((check) => check.name === "runtime")?.status).toBe("ok");
  });

  test("checks Pi RPC runtime", async () => {
    const { paths } = await fixture();
    let checkedExecutable: string | undefined;
    await Effect.runPromise(
      new ConfigStore(paths).setRuntimeEffect({
        kind: "pi-rpc",
        model: "openai-codex/gpt-5.5",
      }),
    );

    const report = await Effect.runPromise(
      runDoctorEffect(paths, {
        checkExecutable: (binary) =>
          Effect.sync(() => {
            checkedExecutable = binary;
            return true;
          }),
        checkPort: () => Effect.succeed(true),
      }),
    );

    expect(checkedExecutable).toBe("pi");
    const runtime = report.checks.find((check) => check.name === "runtime");
    expect(runtime?.status).toBe("ok");
    expect(runtime?.message).toContain("pi (openai-codex/gpt-5.5)");
  });

  test("reports missing Runtime configuration", async () => {
    const { paths } = await fixture();
    const report = await Effect.runPromise(
      runDoctorEffect(paths, {
        checkPort: () => Effect.succeed(true),
      }),
    );

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === "runtime")?.status).toBe("error");
  });

  test("reports unavailable TanStack ACP runtime command", async () => {
    const { paths } = await fixture();
    await Effect.runPromise(
      new ConfigStore(paths).setRuntimeEffect({
        kind: "tanstack-acp",
        name: "codex",
        model: "test-model",
        command: "MISSING=value missing-acp --model {model}",
      }),
    );

    const report = await Effect.runPromise(
      runDoctorEffect(paths, {
        checkExecutable: () => Effect.succeed(false),
        checkPort: () => Effect.succeed(true),
      }),
    );

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === "runtime")?.status).toBe("error");
  });

  test("reports corrupt Tailcat state without aborting doctor", async () => {
    const { paths } = await fixture();
    await mkdir(join(paths.stateRoot, "transport"), { recursive: true });
    await Bun.write(join(paths.stateRoot, "transport", "server.json"), "not-json");

    const report = await Effect.runPromise(
      runDoctorEffect(paths, {
        checkPort: () => Effect.succeed(true),
      }),
    );

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === "tailcat-state")?.status).toBe("error");
  });

  test("reports permissions even when config is invalid", async () => {
    const { paths } = await fixture();
    await Bun.write(paths.configPath, "not-json");
    if (process.platform !== "win32") await chmod(paths.configPath, 0o644);

    const report = await Effect.runPromise(
      runDoctorEffect(paths, {
        checkPort: () => Effect.succeed(true),
      }),
    );

    expect(report.checks.find((check) => check.name === "config")?.status).toBe("error");
    expect(report.checks.find((check) => check.name === "permissions")?.status).toBe(
      process.platform === "win32" ? "ok" : "error",
    );
  });
});
