import { describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import {
  currentServeCommand,
  installUserServiceEffect,
  removeUserServiceEffect,
  runServiceCommandEffect,
  serviceDefinition,
  serviceLauncherPath,
} from "../src/service";

describe("user service definitions", () => {
  test("creates one restartable macOS LaunchAgent", () => {
    const definition = serviceDefinition("darwin", ["/Applications/Qujing/qj", "serve"]);
    expect(definition.path).toContain("com.qujing.daemon.plist");
    expect(definition.content).toContain("<string>serve</string>");
    expect(definition.content).toContain("<key>KeepAlive</key>");
    expect(definition.content).toContain("<key>StandardOutPath</key><string>/dev/null</string>");
    expect(definition.content).not.toContain("sh -c");
  });

  test("creates one restartable Linux service", () => {
    const definition = serviceDefinition("linux", ["/home/alice/Qujing/qj", "serve"]);
    expect(definition.path).toContain("systemd/user/qujing.service");
    expect(definition.content).toContain("After=network-online.target");
    expect(definition.content).toContain('ExecStart="/home/alice/Qujing/qj" "serve"');
    expect(definition.content).toContain("Restart=on-failure");
    expect(definition.content).toContain("StandardOutput=null");
  });
});

test("removes Linux unit before daemon reload", async () => {
  const events: string[] = [];
  await Effect.runPromise(
    removeUserServiceEffect("linux", {
      run: (command: string[]) => Effect.sync(() => void events.push(command.join(" "))),
      remove: () => Effect.sync(() => void events.push("remove")),
    }),
  );
  expect(events).toEqual([
    "systemctl --user disable --now qujing.service",
    "remove",
    "systemctl --user daemon-reload",
  ]);
});

test("uses daemon launcher for macOS service", () => {
  expect(currentServeCommand("darwin", "/opt/homebrew/bin/bun", "/src/cli.ts")).toEqual([
    serviceLauncherPath(),
    "/src/cli.ts",
    "serve",
  ]);
});

test("removes macOS service launcher with its plist", async () => {
  const events: string[] = [];
  await Effect.runPromise(
    removeUserServiceEffect("darwin", {
      run: (command: string[]) => Effect.sync(() => void events.push(command.join(" "))),
      remove: (path: string) => Effect.sync(() => void events.push(`remove ${path}`)),
    }),
  );
  expect(events).toEqual([
    `launchctl bootout gui/${process.getuid?.() ?? 0}/com.qujing.daemon`,
    `remove ${serviceDefinition("darwin", []).path}`,
    `remove ${serviceLauncherPath()}`,
  ]);
});

test("installs and atomically replaces a macOS service launcher", async () => {
  const home = await mkdtemp(join(tmpdir(), "qujing-service-"));
  const launcher = serviceLauncherPath(home);
  const definition = serviceDefinition("darwin", [launcher, "/src/a&b.ts", "serve"], home);
  try {
    await mkdir(dirname(launcher), { recursive: true });
    await symlink("/old/qj", launcher);
    await Effect.runPromise(
      installUserServiceEffect([launcher, "/src/a&b.ts", "serve"], {
        platform: "darwin",
        home,
        executable: "/new/qj",
        run: () => Effect.void,
      }),
    );
    expect(await readlink(launcher)).toBe("/new/qj");
    expect(await readFile(definition.path, "utf8")).toContain("<string>/src/a&amp;b.ts</string>");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("rolls back macOS service launcher when installation fails", async () => {
  for (const previousTarget of [undefined, "/old/qj"] as const) {
    const home = await mkdtemp(join(tmpdir(), "qujing-service-"));
    const launcher = serviceLauncherPath(home);
    try {
      if (previousTarget !== undefined) {
        await mkdir(dirname(launcher), { recursive: true });
        await symlink(previousTarget, launcher);
      }
      await expect(
        Effect.runPromise(
          installUserServiceEffect([launcher, "serve"], {
            platform: "darwin",
            home,
            executable: "/new/qj",
            run: (command: string[]) =>
              command.includes("bootstrap")
                ? Effect.fail(new Error("bootstrap failed"))
                : Effect.void,
          }),
        ),
      ).rejects.toThrow("bootstrap failed");
      if (previousTarget === undefined) {
        await expect(lstat(launcher)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(await readlink(launcher)).toBe(previousTarget);
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
});

test("waits for service command exit codes", async () => {
  await Effect.runPromise(runServiceCommandEffect([process.execPath, "-e", "process.exit(0)"]));
  await expect(
    Effect.runPromise(runServiceCommandEffect([process.execPath, "-e", "process.exit(7)"])),
  ).rejects.toThrow(`${process.execPath} exited 7`);
  await Effect.runPromise(
    runServiceCommandEffect([process.execPath, "-e", "process.exit(7)"], true),
  );
});
