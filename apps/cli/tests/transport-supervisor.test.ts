import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { TailcatSupervisor } from "../src/transport/supervisor";
import type { TransportProcess } from "../src/transport/process";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

describe("TailcatSupervisor", () => {
  test("restarts transport only when allowlist changes and keeps server address stable", async () => {
    const root = await mkdtemp(join(tmpdir(), "colleague-line-tailcat-"));
    roots.push(root);
    const starts: string[][] = [];
    let closes = 0;
    const startEffect = (options: { allowedKeys: string[] }): Effect.Effect<TransportProcess> =>
      Effect.sync(() => {
        starts.push(options.allowedKeys);
        return {
          ready: { ready: true, serverAddress: "tc-stable", remotePort: 43_110 },
          exitedEffect: Effect.never,
          closeEffect: () =>
            Effect.sync(() => {
              closes++;
            }),
        };
      });
    const supervisor = new TailcatSupervisor({ stateRoot: root, port: 43_110, startEffect });

    await Effect.runPromise(supervisor.reloadEffect([]));
    await Effect.runPromise(supervisor.reloadEffect([]));
    await Effect.runPromise(supervisor.reloadEffect(["nodekey:a"]));
    expect(starts).toEqual([[], ["nodekey:a"]]);
    expect(closes).toBe(1);
    expect((await Effect.runPromise(supervisor.stateEffect())).serverAddress).toBe("tc-stable");
    expect((await stat(join(root, "transport", "server.json"))).mode & 0o777).toBe(0o600);
    await Effect.runPromise(supervisor.closeEffect());
    expect(closes).toBe(2);
  });

  test("rejects a changed server address after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "colleague-line-tailcat-"));
    roots.push(root);
    let count = 0;
    const supervisor = new TailcatSupervisor({
      stateRoot: root,
      port: 43_110,
      startEffect: () =>
        Effect.sync(() => ({
          ready: { ready: true, serverAddress: `tc-${++count}`, remotePort: 43_110 },
          exitedEffect: Effect.never,
          closeEffect: () => Effect.void,
        })),
    });
    await Effect.runPromise(supervisor.reloadEffect([]));
    await expect(Effect.runPromise(supervisor.reloadEffect(["nodekey:a"]))).rejects.toThrow(
      "address changed",
    );
  });

  test("does not treat an intentional reload exit as fatal", async () => {
    const root = await mkdtemp(join(tmpdir(), "colleague-line-tailcat-"));
    roots.push(root);
    const failures: string[] = [];
    const supervisor = new TailcatSupervisor({
      stateRoot: root,
      port: 43_110,
      onFatal: (error) => failures.push(error.message),
      startEffect: () =>
        Effect.sync(() => {
          let resolveExit!: (code: number) => void;
          const exited = new Promise<number>((resolve) => {
            resolveExit = resolve;
          });
          return {
            ready: { ready: true, serverAddress: "tc-stable", remotePort: 43_110 },
            exitedEffect: Effect.promise(() => exited),
            closeEffect: () => Effect.sync(() => resolveExit(0)),
          };
        }),
    });

    await Effect.runPromise(supervisor.reloadEffect([]));
    await Effect.runPromise(supervisor.reloadEffect(["nodekey:a"]));
    expect(failures).toEqual([]);
    await Effect.runPromise(supervisor.closeEffect());
    expect(failures).toEqual([]);
  });
});
