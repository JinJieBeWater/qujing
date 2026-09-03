import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../src/config";

it.live("runs ConfigStore Effect API", () =>
  Effect.gen(function* () {
    const root = yield* Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "qujing-effect-test-")),
      catch: (error) => error,
    });
    const workspace = join(root, "workspace");
    const store = new ConfigStore({
      configPath: join(root, "config", "config.json"),
      stateRoot: join(root, "state"),
    });
    yield* Effect.ensuring(
      Effect.gen(function* () {
        yield* Effect.tryPromise({ try: () => mkdir(workspace), catch: (error) => error });
        yield* store.initEffect({ owner: { id: "jason", name: "Jason" } });
        yield* store.addWorkspaceEffect({
          id: "tooling",
          name: "Tooling",
          summary: "Pi tooling",
          root: workspace,
        });
        expect(yield* store.listPublicWorkspacesEffect()).toEqual([
          { id: "tooling", name: "Tooling", summary: "Pi tooling", available: true },
        ]);
      }),
      Effect.tryPromise({
        try: () => rm(root, { recursive: true, force: true }),
        catch: (error) => error,
      }).pipe(Effect.orDie),
    );
  }),
);
