import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentConfigStore } from "../src/agent-config";

it.live("runs AgentConfigStore Effect API", () =>
  Effect.gen(function* () {
    const root = yield* Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "qujing-agent-effect-test-")),
      catch: (error) => error,
    });
    const key = join(root, "key");
    const store = new AgentConfigStore({ configPath: join(root, "config", "agent.json") });
    yield* Effect.ensuring(
      Effect.gen(function* () {
        yield* Effect.tryPromise({ try: () => writeFile(key, "key"), catch: (error) => error });
        yield* Effect.tryPromise({ try: () => chmod(key, 0o600), catch: (error) => error });
        const initialized = yield* store.initEffect();
        expect(initialized.initialized).toBe(true);
        yield* store.addEffect({
          id: "peer",
          expectedNodeId: "node",
          remoteAgentId: "agent",
          serverAddress: "tailcat",
          remotePort: 43110,
          keyPath: key,
          remoteBearer: "remote-secret",
        });
        expect(yield* store.listEffect()).toHaveLength(1);
        expect(yield* store.removeEffect("peer")).toBe(true);
      }),
      Effect.tryPromise({
        try: () => rm(root, { recursive: true, force: true }),
        catch: (error) => error,
      }).pipe(Effect.orDie),
    );
  }),
);
