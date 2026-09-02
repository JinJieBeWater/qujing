import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createColleagueLine } from "../src/colleague-line";
import { ConfigStore } from "../src/config";

it.live("runs ColleagueLine Effect API", () =>
  Effect.gen(function* () {
    const root = yield* node(() => mkdtemp(join(tmpdir(), "colleague-line-effect-api-")));
    const workspace = join(root, "workspace");
    const config = new ConfigStore({
      configPath: join(root, "config.json"),
      stateRoot: join(root, "state"),
    });
    const app = createColleagueLine({
      config,
      coordinator: {
        answerEffect: ({ question }) => Effect.succeed(`answer:${question}`),
      },
    });
    yield* Effect.ensuring(
      Effect.gen(function* () {
        yield* node(() => mkdir(workspace));
        yield* config.initEffect({ owner: { id: "owner", name: "Owner" } });
        yield* config.addWorkspaceEffect({
          id: "docs",
          name: "Docs",
          summary: "Docs",
          root: workspace,
        });
        const { bearer } = yield* config.addClientEffect({
          id: "client",
          tailcatKey: "nodekey:test",
        });
        const client = yield* config.authenticateEffect(bearer);
        expect(client).toBeDefined();
        expect(yield* app.listWorkspacesEffect(client!)).toEqual({
          owner: { id: "owner", name: "Owner" },
          workspaces: [{ id: "docs", name: "Docs", summary: "Docs", available: true }],
        });
        expect(
          yield* app.askEffect(
            { client: client!, workspace: "docs", question: "hello" },
            new AbortController().signal,
          ),
        ).toEqual({ workspace: "docs", answer: "answer:hello" });
      }),
      node(() => rm(root, { recursive: true, force: true })).pipe(Effect.orDie),
    );
  }),
);

function node<A>(try_: () => Promise<A>) {
  return Effect.tryPromise({ try: try_, catch: (error) => error });
}
