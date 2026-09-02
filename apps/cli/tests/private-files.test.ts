import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  assertPrivatePathEffect,
  assertPrivateTreeEffect,
  withPrivateLock,
  writePrivateJsonEffect,
} from "../src/private-files";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "colleague-line-private-"));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}

describe("private state", () => {
  test("writes durable private JSON and validates the tree", async () => {
    const root = await fixture();
    await Effect.runPromise(
      writePrivateJsonEffect(join(root, "nested", "state.json"), { ok: true }),
    );
    await expect(Effect.runPromise(assertPrivateTreeEffect(root))).resolves.toBeUndefined();
  });

  test("rejects permissive files and symlinks", async () => {
    if (process.platform === "win32") return;
    const root = await fixture();
    const file = join(root, "state.json");
    await writeFile(file, "{}", { mode: 0o600 });
    await chmod(file, 0o644);
    await expect(Effect.runPromise(assertPrivatePathEffect(file, false))).rejects.toThrow(
      "permissions",
    );
    await chmod(file, 0o600);
    const link = join(root, "link.json");
    await symlink(file, link);
    await expect(Effect.runPromise(assertPrivatePathEffect(link, false))).rejects.toThrow(
      "symlink",
    );
  });

  test("never steals an old lock from a live process", async () => {
    const root = await fixture();
    const path = join(root, "config.json");
    let releaseFirst!: () => void;
    let markStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const first = Effect.runPromise(
      withPrivateLock(
        path,
        Effect.tryPromise({
          try: async () => {
            markStarted();
            await firstGate;
          },
          catch: (error) => error,
        }),
      ),
    );
    await started;
    const old = new Date(Date.now() - 120_000);
    await utimes(`${path}.lock`, old, old);
    let secondEntered = false;
    const second = Effect.runPromise(
      withPrivateLock(
        path,
        Effect.sync(() => {
          secondEntered = true;
        }),
      ),
    );
    await Bun.sleep(100);
    expect(secondEntered).toBe(false);
    releaseFirst();
    await Promise.all([first, second]);
    expect(secondEntered).toBe(true);
  });

  test("recovers a lock owned by a dead process", async () => {
    const root = await fixture();
    const path = join(root, "config.json");
    await writeFile(`${path}.lock`, JSON.stringify({ pid: 999_999_999, nonce: "dead" }), {
      mode: 0o600,
    });
    let entered = false;
    await Effect.runPromise(
      withPrivateLock(
        path,
        Effect.sync(() => {
          entered = true;
        }),
      ),
    );
    expect(entered).toBe(true);
  });

  test("serializes concurrent process recovery of one stale lock", async () => {
    const root = await fixture();
    const path = join(root, "config.json");
    const log = join(root, "critical.log");
    await writeFile(`${path}.lock`, JSON.stringify({ pid: 999_999_999, nonce: "dead" }), {
      mode: 0o600,
    });
    const worker = join(import.meta.dir, "fixtures", "lock-worker.ts");
    const children = Array.from({ length: 5 }, () =>
      Bun.spawn([process.execPath, worker, path, log], { stdout: "ignore", stderr: "inherit" }),
    );
    expect(await Promise.all(children.map((child) => child.exited))).toEqual([0, 0, 0, 0, 0]);
    const lines = (await Bun.file(log).text()).trim().split("\n");
    expect(lines).toHaveLength(10);
    for (let index = 0; index < lines.length; index += 2) {
      expect(lines[index]!.replace("start", "end")).toBe(lines[index + 1]!);
    }
  });
});
