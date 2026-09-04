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
  await Effect.runPromise(
    config.initEffect({ owner: { id: "owner", name: "Owner" }, port: 43_199 }),
  );
  await Effect.runPromise(
    config.addWorkspaceEffect({ id: "docs", name: "Docs", summary: "Docs", root: workspace }),
  );
  return { root, paths, workspace };
}

describe("doctor", () => {
  test("checks owner config, global Pi, workspace, port, and transport without prompting", async () => {
    const { paths } = await fixture();
    const report = await Effect.runPromise(
      runDoctorEffect(paths, {
        checkPi: () => Effect.succeed(true),
        checkPort: () => Effect.succeed(true),
      }),
    );

    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.name)).toEqual(
      expect.arrayContaining([
        "config",
        "permissions",
        "pi",
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
        checkPi: () => Effect.succeed(true),
        checkPort: () => Effect.succeed(true),
      }),
    );

    expect(report.ok).toBe(false);
    expect(
      report.checks.filter((check) => check.status === "error").map((check) => check.name),
    ).toEqual(expect.arrayContaining(["permissions", "workspace:docs"]));
  });

  test("checks TanStack ACP runtime without requiring global Pi", async () => {
    const { paths } = await fixture();
    let checkedExecutable: string | undefined;
    await Effect.runPromise(
      new ConfigStore(paths).setRuntimeEffect({
        kind: "tanstack-acp",
        name: "codex",
        model: "gpt-5-codex",
        command: "codex --acp --model {model} --cwd {cwd}",
      }),
    );

    const report = await Effect.runPromise(
      runDoctorEffect(paths, {
        checkPi: () => Effect.succeed(false),
        checkExecutable: (binary) =>
          Effect.sync(() => {
            checkedExecutable = binary;
            return true;
          }),
        checkPort: () => Effect.succeed(true),
      }),
    );

    expect(report.checks.find((check) => check.name === "pi")).toBeUndefined();
    expect(checkedExecutable).toBe("codex");
    expect(report.checks.find((check) => check.name === "runtime")?.status).toBe("ok");
  });

  test("reports unavailable TanStack ACP runtime command", async () => {
    const { paths } = await fixture();
    await Effect.runPromise(
      new ConfigStore(paths).setRuntimeEffect({
        kind: "tanstack-acp",
        name: "codex",
        model: "gpt-5-codex",
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
        checkPi: () => Effect.succeed(true),
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
        checkPi: () => Effect.succeed(true),
        checkPort: () => Effect.succeed(true),
      }),
    );

    expect(report.checks.find((check) => check.name === "config")?.status).toBe("error");
    expect(report.checks.find((check) => check.name === "permissions")?.status).toBe(
      process.platform === "win32" ? "ok" : "error",
    );
  });
});
