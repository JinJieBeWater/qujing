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
          [store.getOrCreateEffect("agent", "docs"), store.getOrCreateEffect("agent", "docs")],
          { concurrency: "unbounded" },
        );
        expect(concurrent.id).toBe(first.id);
        yield* store.getOrCreateEffect("agent", "code");
        expect(yield* store.matchingEffect((session) => session.peerId === "agent")).toHaveLength(
          2,
        );
        yield* store.touchEffect(first);
        expect((yield* store.listEffect()).find((session) => session.id === first.id)?.id).toBe(
          first.id,
        );
        yield* store.removeEffect(first);
        expect(yield* store.listEffect()).toMatchObject([{ peerId: "agent", workspaceId: "code" }]);

        const peerId = "broken";
        const workspaceId = "docs";
        const key = createHash("sha256")
          .update(peerId)
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
        expect((yield* Effect.exit(store.getOrCreateEffect(peerId, workspaceId)))._tag).toBe(
          "Failure",
        );
        yield* Effect.tryPromise({ try: () => rm(binding), catch: (error) => error });
        expect((yield* store.getOrCreateEffect(peerId, workspaceId)).peerId).toBe(peerId);
      }),
      Effect.tryPromise({
        try: () => rm(root, { recursive: true, force: true }),
        catch: (error) => error,
      }).pipe(Effect.orDie),
    );
  }),
);
