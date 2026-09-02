import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner";
import { Effect, FileSystem, Layer } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { PlatformLayer } from "./effect-runtime";

const ServiceLayer = Layer.provideMerge(BunChildProcessSpawner.layer, PlatformLayer);
export type ServiceRole = "gateway" | "client";
export interface ServiceDefinition {
  path: string;
  content: string;
}
export function serviceDefinition(
  platform: NodeJS.Platform,
  command: string[],
  role: ServiceRole,
): ServiceDefinition {
  const label = `com.colleague-line.${role}`;
  if (platform === "darwin")
    return {
      path: join(homedir(), "Library", "LaunchAgents", `${label}.plist`),
      content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>${command.map((part) => `<string>${xml(part)}</string>`).join("")}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>
`,
    };
  if (platform === "linux")
    return {
      path: join(
        process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
        "systemd",
        "user",
        `colleague-line-${role}.service`,
      ),
      content: `[Unit]
Description=Colleague Line ${role === "gateway" ? "Owner Gateway" : "Agent Client"}
After=network-online.target

[Service]
Type=simple
ExecStart=${command.map(systemdQuote).join(" ")}
Restart=on-failure
RestartSec=5
StandardOutput=null
StandardError=null

[Install]
WantedBy=default.target
`,
    };
  throw new Error(`User service installation is unsupported on ${platform}`);
}
export const installUserServiceEffect = (command: string[], role: ServiceRole) =>
  Effect.gen(function* () {
    const definition = serviceDefinition(process.platform, command, role);
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(dirname(definition.path), { recursive: true });
    yield* fs.writeFile(definition.path, new TextEncoder().encode(definition.content), {
      mode: 0o600,
    });
    if (process.platform === "darwin") {
      yield* runEffect(
        ["launchctl", "bootout", `gui/${process.getuid?.() ?? 0}/com.colleague-line.${role}`],
        true,
      );
      yield* runEffect([
        "launchctl",
        "bootstrap",
        `gui/${process.getuid?.() ?? 0}`,
        definition.path,
      ]);
    } else {
      yield* runEffect(["systemctl", "--user", "daemon-reload"]);
      yield* runEffect([
        "systemctl",
        "--user",
        "enable",
        "--now",
        `colleague-line-${role}.service`,
      ]);
    }
    return definition.path;
  }).pipe(Effect.provide(ServiceLayer));
interface RemoveServiceOperations {
  run(command: string[], allowFailure?: boolean): Effect.Effect<void, unknown>;
  remove(path: string): Effect.Effect<void, unknown>;
}
export const removeUserServiceEffect = (
  role: ServiceRole,
  platform: NodeJS.Platform = process.platform,
  operations?: RemoveServiceOperations,
) => {
  const definition = serviceDefinition(platform, currentServeCommand(role), role);
  if (operations)
    return Effect.gen(function* () {
      if (platform === "darwin") {
        yield* operations.run(
          ["launchctl", "bootout", `gui/${process.getuid?.() ?? 0}/com.colleague-line.${role}`],
          true,
        );
        yield* operations.remove(definition.path);
      } else {
        yield* operations.run(
          ["systemctl", "--user", "disable", "--now", `colleague-line-${role}.service`],
          true,
        );
        yield* operations.remove(definition.path);
        yield* operations.run(["systemctl", "--user", "daemon-reload"]);
      }
      return definition.path;
    });
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (platform === "darwin") {
      yield* runEffect(
        ["launchctl", "bootout", `gui/${process.getuid?.() ?? 0}/com.colleague-line.${role}`],
        true,
      );
      yield* fs.remove(definition.path, { force: true });
    } else {
      yield* runEffect(
        ["systemctl", "--user", "disable", "--now", `colleague-line-${role}.service`],
        true,
      );
      yield* fs.remove(definition.path, { force: true });
      yield* runEffect(["systemctl", "--user", "daemon-reload"]);
    }
    return definition.path;
  }).pipe(Effect.provide(PlatformLayer));
};
export function currentServeCommand(role: ServiceRole): string[] {
  const script = process.argv[1];
  return script?.endsWith(".ts")
    ? [process.execPath, script, role, "serve"]
    : [process.execPath, role, "serve"];
}
const runEffect = (command: string[], allowFailure = false) =>
  Effect.scoped(
    Effect.gen(function* () {
      const code = Number(
        yield* ChildProcess.make(command[0]!, command.slice(1), {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      );
      if (code !== 0 && !allowFailure)
        return yield* Effect.fail(new Error(`${command[0]} exited ${code}`));
    }),
  ).pipe(Effect.provide(ServiceLayer));
function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function systemdQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
