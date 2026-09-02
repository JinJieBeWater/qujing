import { afterEach, expect, test } from "bun:test";
import { Effect } from "effect";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientConfigStore } from "../src/client-config";
import { runClientDoctorEffect } from "../src/client-doctor";

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
  await Effect.runPromise(store.initEffect({ port: 43222 }));
  await Effect.runPromise(
    store.addEffect({
      id: "one",
      expectedOwnerId: "owner",
      remoteClientId: "remote",
      serverAddress: "tailcat",
      remotePort: 43110,
      keyPath,
      remoteBearer: "bearer",
    }),
  );

  const report = await Effect.runPromise(
    runClientDoctorEffect(
      { clientConfigPath: configPath, clientStateRoot: stateRoot, transportBinary },
      {
        checkPort: () => Effect.succeed(true),
        inspectLines: () => Effect.succeed([{ id: "one", available: false }]),
      },
    ),
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
  await Effect.runPromise(store.initEffect());
  const report = await Effect.runPromise(
    runClientDoctorEffect(
      { clientConfigPath: configPath, clientStateRoot: stateRoot, transportBinary },
      { checkPort: () => Effect.succeed(true), inspectLines: () => Effect.succeed([]) },
    ),
  );
  expect(report.checks.find(({ name }) => name === "state")?.status).toBe("error");
});

test("reports invalid Client config without aborting doctor", async () => {
  const root = await mkdtemp(join(tmpdir(), "colleague-line-client-doctor-config-"));
  roots.push(root);
  const configPath = join(root, "config", "client.json");
  const stateRoot = join(root, "state");
  const transportBinary = join(root, "transport");
  await Bun.write(transportBinary, "binary");
  await chmod(transportBinary, 0o700);
  await Effect.runPromise(new ClientConfigStore({ configPath }).initEffect());
  await Bun.write(configPath, "not-json");
  if (process.platform !== "win32") await chmod(configPath, 0o600);

  const report = await Effect.runPromise(
    runClientDoctorEffect({
      clientConfigPath: configPath,
      clientStateRoot: stateRoot,
      transportBinary,
    }),
  );

  expect(report.ok).toBe(false);
  expect(report.checks.find(({ name }) => name === "config")?.status).toBe("error");
});
