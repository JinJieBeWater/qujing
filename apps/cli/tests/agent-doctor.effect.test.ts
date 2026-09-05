import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { AgentConfigStore } from "../src/agent-config";
import { runAgentDoctorEffect } from "../src/agent-doctor";

it.effect("runs Agent doctor Effect", () =>
  Effect.gen(function* () {
    const root = yield* promise(() => mkdtemp(join(tmpdir(), "qujing-agent-doctor-effect-")));
    const paths = {
      agentConfigPath: join(root, "config", "agent.json"),
      agentStateRoot: join(root, "state"),
      transportBinary: join(root, "transport"),
    };
    try {
      yield* promise(() => Bun.write(paths.transportBinary, "binary"));
      yield* promise(() => chmod(paths.transportBinary, 0o700));
      const store = new AgentConfigStore({ configPath: paths.agentConfigPath });
      yield* store.initEffect();
      const report = yield* runAgentDoctorEffect(paths, {
        checkPort: () => Effect.succeed(true),
        inspectPeers: () => Effect.succeed([]),
      });
      expect(report.ok).toBe(true);
      expect(report.checks.map(({ name }) => name)).toEqual([
        "config",
        "state",
        "transport",
        "port",
      ]);
    } finally {
      yield* promise(() => rm(root, { recursive: true, force: true }));
    }
  }),
);

function promise<A>(try_: () => Promise<A>) {
  return Effect.tryPromise({ try: try_, catch: (error) => error });
}
