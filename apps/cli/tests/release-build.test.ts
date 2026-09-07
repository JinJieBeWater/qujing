import { expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

test("release preflight rejects invalid targets and missing tools before changing dist", async () => {
  const script = fileURLToPath(new URL("../../../scripts/build-release.ts", import.meta.url));
  const destination = new URL("../../../dist", import.meta.url);
  const before = await stat(destination).catch(() => undefined);
  for (const [target, error] of [
    ["invalid-target", "Unknown release target"],
    ["all", "Missing release tools"],
  ]) {
    const child = Bun.spawn([process.execPath, script, target!], {
      env: { ...process.env, PATH: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).not.toBe(0);
    expect(stderr).toContain(error!);
  }
  expect((await stat(destination).catch(() => undefined))?.mtimeMs).toBe(before?.mtimeMs);
});
