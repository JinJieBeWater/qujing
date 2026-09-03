import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireGatewayLockEffect,
  acquireMaintenanceLockEffect,
  acquireProcessLockEffect,
  processLockActiveEffect,
} from "../src/process-lock";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

describe("process lock", () => {
  test("excludes another Gateway until released", async () => {
    const root = await mkdtemp(join(tmpdir(), "qujing-lock-"));
    roots.push(root);
    const path = join(root, "gateway.lock");
    const release = await Effect.runPromise(acquireProcessLockEffect(path));
    await expect(Effect.runPromise(acquireProcessLockEffect(path))).rejects.toThrow(
      "already running",
    );
    await Effect.runPromise(release);
    const releaseAgain = await Effect.runPromise(acquireProcessLockEffect(path));
    await Effect.runPromise(releaseAgain);
  });

  test("recovers a lock owned by a dead process", async () => {
    const root = await mkdtemp(join(tmpdir(), "qujing-lock-"));
    roots.push(root);
    const path = join(root, "gateway.lock");
    await writeFile(path, JSON.stringify({ pid: 999_999_999, nonce: "dead" }));
    const release = await Effect.runPromise(acquireProcessLockEffect(path));
    await Effect.runPromise(release);
  });

  test("recovers an interrupted stale-lock quarantine on the first restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "qujing-lock-"));
    roots.push(root);
    const path = join(root, "gateway.lock");
    await writeFile(`${path}.recovering`, JSON.stringify({ pid: 999_999_999, nonce: "dead" }));
    const old = new Date(Date.now() - 120_000);
    await utimes(`${path}.recovering`, old, old);
    const release = await Effect.runPromise(acquireProcessLockEffect(path));
    expect(await Effect.runPromise(processLockActiveEffect(path))).toBe(true);
    await Effect.runPromise(release);
  });

  test("does not delete a fresh lock whose owner write is incomplete", async () => {
    const root = await mkdtemp(join(tmpdir(), "qujing-lock-"));
    roots.push(root);
    const path = join(root, "gateway.lock");
    await writeFile(path, "");
    const pending = Effect.runPromise(acquireProcessLockEffect(path));
    await Bun.sleep(25);
    await writeFile(path, JSON.stringify({ pid: process.pid, nonce: "live" }));

    await expect(pending).rejects.toThrow("already running");
  });

  test("active check waits for a fresh owner write", async () => {
    const root = await mkdtemp(join(tmpdir(), "qujing-lock-"));
    roots.push(root);
    const path = join(root, "gateway.lock");
    await writeFile(path, "");
    const pending = Effect.runPromise(processLockActiveEffect(path));
    await Bun.sleep(25);
    await writeFile(path, JSON.stringify({ pid: process.pid, nonce: "live" }));
    expect(await pending).toBe(true);
  });
  test("keeps Gateway and offline maintenance mutually exclusive", async () => {
    const root = await mkdtemp(join(tmpdir(), "qujing-lock-"));
    roots.push(root);

    const releaseMaintenance = await Effect.runPromise(acquireMaintenanceLockEffect(root));
    await expect(Effect.runPromise(acquireGatewayLockEffect(root))).rejects.toThrow(
      "maintenance is in progress",
    );
    expect(await Effect.runPromise(processLockActiveEffect(join(root, "gateway.lock")))).toBe(
      false,
    );
    await Effect.runPromise(releaseMaintenance);

    const releaseGateway = await Effect.runPromise(acquireGatewayLockEffect(root));
    await expect(Effect.runPromise(acquireMaintenanceLockEffect(root))).rejects.toThrow(
      "Gateway is already running",
    );
    await Effect.runPromise(releaseGateway);
  });
});
