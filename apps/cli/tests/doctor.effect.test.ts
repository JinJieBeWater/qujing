import { chmod, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { ConfigStore } from "../src/config";
import { runDoctorEffect } from "../src/doctor";

it.effect("runs doctor Effect", () =>
  Effect.gen(function* () {
    const root = yield* promise(() => mkdtemp(join(tmpdir(), "qujing-doctor-effect-")));
    const paths = {
      configPath: join(root, "config", "config.json"),
      stateRoot: join(root, "state"),
      transportBinary: join(root, "transport"),
    };
    try {
      yield* promise(() => mkdir(join(root, "workspace")));
      yield* promise(() => Bun.write(paths.transportBinary, "binary"));
      yield* promise(() => chmod(paths.transportBinary, 0o700));
      const config = new ConfigStore(paths);
      yield* config.initEffect({ node: { id: "node", name: "Node" }, port: 43_199 });
      yield* config.addWorkspaceEffect({
        id: "docs",
        name: "Docs",
        summary: "Docs",
        root: join(root, "workspace"),
      });
      yield* config.setRuntimeEffect({
        kind: "tanstack-acp",
        name: "codex",
        model: "test-model",
        command: "agent --acp --model {model} --cwd {cwd}",
      });
      const report = yield* runDoctorEffect(paths, {
        checkExecutable: () => Effect.succeed(true),
        checkPort: () => Effect.succeed(true),
      });
      expect(report.ok).toBe(true);
      expect(report.checks.map(({ name }) => name)).toEqual([
        "config",
        "permissions",
        "workspace:docs",
        "port",
        "transport",
        "runtime",
        "tailcat-state",
      ]);
    } finally {
      yield* promise(() => rm(root, { recursive: true, force: true }));
    }
  }),
);

function promise<A>(try_: () => Promise<A>) {
  return Effect.tryPromise({ try: try_, catch: (error) => error });
}
