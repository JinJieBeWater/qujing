import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQujing } from "../src/qujing";
import { ConfigStore } from "../src/config";

it.live("runs Qujing Effect API", () =>
  Effect.gen(function* () {
    const root = yield* node(() => mkdtemp(join(tmpdir(), "qujing-effect-api-")));
    const workspace = join(root, "workspace");
    const config = new ConfigStore({
      configPath: join(root, "config.json"),
      stateRoot: join(root, "state"),
    });
    const app = createQujing({
      config,
      coordinator: {
        answerEffect: ({ question }) => Effect.succeed(`answer:${question}`),
      },
    });
    yield* Effect.ensuring(
      Effect.gen(function* () {
        yield* node(() => mkdir(workspace));
        yield* config.initEffect({ node: { id: "node", name: "Node" } });
        yield* config.addWorkspaceEffect({
          id: "docs",
          name: "Docs",
          summary: "Docs",
          root: workspace,
        });
        const { bearer } = yield* config.addAgentEffect({
          id: "agent",
          tailcatKey: "nodekey:test",
        });
        const agent = yield* config.authenticateEffect(bearer);
        expect(agent).toBeDefined();
        expect(yield* app.listWorkspacesEffect(agent!)).toEqual({
          node: { id: "node", name: "Node" },
          workspaces: [{ id: "docs", name: "Docs", summary: "Docs", available: true }],
        });
        expect(
          yield* app.askEffect(
            { peer: agent!, workspace: "docs", question: "hello" },
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
