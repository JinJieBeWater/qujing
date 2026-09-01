import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientConfigStore } from "../src/client-config";
import { runClientDoctor } from "../src/client-doctor";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("checks private Client state, transport, port, and each Line independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "colleague-line-client-doctor-"));
  roots.push(root);
  const configPath = join(root, "config", "client.json");
  const stateRoot = join(root, "state");
  const transportBinary = join(root, "transport");
  const keyPath = join(root, "line.key");
  await Bun.write(transportBinary, "binary");
  await chmod(transportBinary, 0o700);
  await Bun.write(keyPath, "key");
  await chmod(keyPath, 0o600);
  const store = new ClientConfigStore({ configPath });
  await store.init({ port: 43222 });
  await store.add({
    id: "one",
    expectedOwnerId: "owner",
    remoteClientId: "remote",
    serverAddress: "tailcat",
    remotePort: 43110,
    keyPath,
    remoteBearer: "bearer",
  });

  const report = await runClientDoctor(
    { clientConfigPath: configPath, clientStateRoot: stateRoot, transportBinary },
    {
      checkPort: async () => true,
      inspectLines: async () => [{ id: "one", available: false }],
    },
  );
  expect(report.ok).toBe(false);
  expect(report.checks).toEqual(
    expect.arrayContaining([
      { name: "config", status: "ok", message: "Client config is valid and private" },
      { name: "line-key:one", status: "ok", message: "Line key is private" },
      { name: "line:one", status: "error", message: "Line is unavailable" },
    ]),
  );
});

test("reports unsafe Client state permissions", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "colleague-line-client-doctor-state-"));
  roots.push(root);
  const configPath = join(root, "config", "client.json");
  const stateRoot = join(root, "state");
  const transportBinary = join(root, "transport");
  await Bun.write(transportBinary, "binary");
  await chmod(transportBinary, 0o700);
  await Bun.write(join(stateRoot, "entry"), "state");
  await chmod(stateRoot, 0o755);
  const store = new ClientConfigStore({ configPath });
  await store.init();
  const report = await runClientDoctor(
    { clientConfigPath: configPath, clientStateRoot: stateRoot, transportBinary },
    { checkPort: async () => true, inspectLines: async () => [] },
  );
  expect(report.checks.find(({ name }) => name === "state")?.status).toBe("error");
});
