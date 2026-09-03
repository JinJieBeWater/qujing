import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeSessionStore } from "../src/runtime/sessions";

it.live("runs RuntimeSessionStore Effect API", () =>
  Effect.gen(function* () {
    const root = yield* Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "qujing-session-effect-test-")),
      catch: (error) => error,
    });
    const store = new RuntimeSessionStore(root);
    yield* Effect.ensuring(
      Effect.gen(function* () {
        const [first, concurrent] = yield* Effect.all(
          [store.getOrCreateEffect("client", "docs"), store.getOrCreateEffect("client", "docs")],
          { concurrency: "unbounded" },
        );
        expect(concurrent.id).toBe(first.id);
        yield* store.getOrCreateEffect("client", "code");
        expect(
          yield* store.matchingEffect((session) => session.clientId === "client"),
        ).toHaveLength(2);
        yield* store.touchEffect(first);
        expect((yield* store.listEffect()).find((session) => session.id === first.id)?.id).toBe(
          first.id,
        );
        yield* store.removeEffect(first);
        expect(yield* store.listEffect()).toMatchObject([
          { clientId: "client", workspaceId: "code" },
        ]);

        const clientId = "broken";
        const workspaceId = "docs";
        const key = createHash("sha256")
          .update(clientId)
          .update("\0")
          .update(workspaceId)
          .digest("hex");
        const binding = join(root, "runtime-sessions", `${key}.json`);
        yield* Effect.tryPromise({
          try: () => mkdir(join(root, "runtime-sessions"), { recursive: true }),
          catch: (error) => error,
        });
        yield* Effect.tryPromise({
          try: () => writeFile(binding, "invalid"),
          catch: (error) => error,
        });
        expect((yield* Effect.exit(store.getOrCreateEffect(clientId, workspaceId)))._tag).toBe(
          "Failure",
        );
        yield* Effect.tryPromise({ try: () => rm(binding), catch: (error) => error });
        expect((yield* store.getOrCreateEffect(clientId, workspaceId)).clientId).toBe(clientId);
      }),
      Effect.tryPromise({
        try: () => rm(root, { recursive: true, force: true }),
        catch: (error) => error,
      }).pipe(Effect.orDie),
    );
  }),
);
