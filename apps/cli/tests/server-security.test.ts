import { afterEach, describe, expect, test } from "bun:test";
import { Context, Effect, Exit, Scope } from "effect";
import { chmod, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../src/config";
import { startServerEffect } from "../src/server";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

describe("Gateway private-state boundary", () => {
  test("fails closed before Runtime startup when private state is permissive", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "qujing-server-security-"));
    roots.push(root);
    const paths = {
      configPath: join(root, "config", "config.json"),
      stateRoot: join(root, "state"),
    };
    await mkdir(join(root, "workspace"));
    await Effect.runPromise(
      new ConfigStore(paths).initEffect({ owner: { id: "owner", name: "Owner" } }),
    );
    await chmod(paths.configPath, 0o644);

    const scope = await Effect.runPromise(Scope.make("sequential"));
    await expect(
      Effect.runPromise(
        Effect.provide(startServerEffect(paths, scope), Context.make(Scope.Scope, scope)),
      ),
    ).rejects.toThrow("Private state permissions");
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(await Bun.file(join(paths.stateRoot, "gateway.lock")).exists()).toBe(false);
  });
});
