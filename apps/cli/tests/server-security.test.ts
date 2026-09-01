import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../src/config";
import { startServer } from "../src/server";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

describe("Gateway private-state boundary", () => {
  test("fails closed before Runtime startup when private state is permissive", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "colleague-line-server-security-"));
    roots.push(root);
    const paths = {
      configPath: join(root, "config", "config.json"),
      stateRoot: join(root, "state"),
    };
    await mkdir(join(root, "workspace"));
    await new ConfigStore(paths).init({
      owner: { id: "owner", name: "Owner" },
    });
    await chmod(paths.configPath, 0o644);

    await expect(startServer(paths)).rejects.toThrow("Private state permissions");
    expect(await Bun.file(join(paths.stateRoot, "gateway.lock")).exists()).toBe(false);
  });
});
