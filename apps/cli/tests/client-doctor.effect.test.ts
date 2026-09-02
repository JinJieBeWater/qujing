import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { ClientConfigStore } from "../src/client-config";
import { runClientDoctorEffect } from "../src/client-doctor";

it.effect("runs Client doctor Effect", () =>
  Effect.gen(function* () {
    const root = yield* promise(() =>
      mkdtemp(join(tmpdir(), "colleague-line-client-doctor-effect-")),
    );
    const paths = {
      clientConfigPath: join(root, "config", "client.json"),
      clientStateRoot: join(root, "state"),
      transportBinary: join(root, "transport"),
    };
    try {
      yield* promise(() => Bun.write(paths.transportBinary, "binary"));
      yield* promise(() => chmod(paths.transportBinary, 0o700));
      const store = new ClientConfigStore({ configPath: paths.clientConfigPath });
      yield* store.initEffect();
      const report = yield* runClientDoctorEffect(paths, {
        checkPort: () => Effect.succeed(true),
        inspectLines: () => Effect.succeed([]),
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
