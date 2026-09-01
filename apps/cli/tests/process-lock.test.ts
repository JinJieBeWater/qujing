import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireGatewayLock,
  acquireMaintenanceLock,
  acquireProcessLock,
  processLockActive,
} from "../src/process-lock";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

describe("process lock", () => {
  test("excludes another Gateway until released", async () => {
    const root = await mkdtemp(join(tmpdir(), "colleague-line-lock-"));
    roots.push(root);
    const path = join(root, "gateway.lock");
    const release = await acquireProcessLock(path);
    await expect(acquireProcessLock(path)).rejects.toThrow("already running");
    await release();
    const releaseAgain = await acquireProcessLock(path);
    await releaseAgain();
  });

  test("recovers a lock owned by a dead process", async () => {
    const root = await mkdtemp(join(tmpdir(), "colleague-line-lock-"));
    roots.push(root);
    const path = join(root, "gateway.lock");
    await writeFile(path, JSON.stringify({ pid: 999_999_999, nonce: "dead" }));
    const release = await acquireProcessLock(path);
    await release();
  });

  test("recovers an interrupted stale-lock quarantine on the first restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "colleague-line-lock-"));
    roots.push(root);
    const path = join(root, "gateway.lock");
    await writeFile(`${path}.recovering`, JSON.stringify({ pid: 999_999_999, nonce: "dead" }));
    const release = await acquireProcessLock(path);
    expect(await processLockActive(path)).toBe(true);
    await release();
  });

  test("does not delete a fresh lock whose owner write is incomplete", async () => {
    const root = await mkdtemp(join(tmpdir(), "colleague-line-lock-"));
    roots.push(root);
    const path = join(root, "gateway.lock");
    await writeFile(path, "");
    const pending = acquireProcessLock(path);
    await Bun.sleep(25);
    await writeFile(path, JSON.stringify({ pid: process.pid, nonce: "live" }));

    await expect(pending).rejects.toThrow("already running");
  });

  test("active check waits for a fresh owner write", async () => {
    const root = await mkdtemp(join(tmpdir(), "colleague-line-lock-"));
    roots.push(root);
    const path = join(root, "gateway.lock");
    await writeFile(path, "");
    const pending = processLockActive(path);
    await Bun.sleep(25);
    await writeFile(path, JSON.stringify({ pid: process.pid, nonce: "live" }));
    expect(await pending).toBe(true);
  });
  test("keeps Gateway and offline maintenance mutually exclusive", async () => {
    const root = await mkdtemp(join(tmpdir(), "colleague-line-lock-"));
    roots.push(root);

    const releaseMaintenance = await acquireMaintenanceLock(root);
    await expect(acquireGatewayLock(root)).rejects.toThrow("maintenance is in progress");
    expect(await processLockActive(join(root, "gateway.lock"))).toBe(false);
    await releaseMaintenance();

    const releaseGateway = await acquireGatewayLock(root);
    await expect(acquireMaintenanceLock(root)).rejects.toThrow("Gateway is already running");
    await releaseGateway();
  });
});
