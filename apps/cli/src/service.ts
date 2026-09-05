import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner";
import { Effect, Exit, FileSystem, Layer } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { PlatformLayer } from "./effect-runtime";

const ServiceLayer = Layer.provideMerge(BunChildProcessSpawner.layer, PlatformLayer);
export type ServiceRole = "node" | "agent";
export interface ServiceDefinition {
  path: string;
  content: string;
}
export function serviceDefinition(
  platform: NodeJS.Platform,
  command: string[],
  role: ServiceRole,
  home = homedir(),
): ServiceDefinition {
  const label = `com.qujing.${role}`;
  if (platform === "darwin")
    return {
      path: join(home, "Library", "LaunchAgents", `${label}.plist`),
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
        process.env.XDG_CONFIG_HOME ?? join(home, ".config"),
        "systemd",
        "user",
        `qujing-${role}.service`,
      ),
      content: `[Unit]
Description=Qujing ${role === "node" ? "Node" : "Agent"}
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
export interface InstallServiceOptions {
  platform?: NodeJS.Platform;
  home?: string;
  executable?: string;
  run?: (command: string[], allowFailure?: boolean) => Effect.Effect<void, unknown>;
}
export const installUserServiceEffect = (
  command: string[],
  role: ServiceRole,
  options: InstallServiceOptions = {},
) =>
  Effect.gen(function* () {
    const platform = options.platform ?? process.platform;
    const home = options.home ?? homedir();
    const executable = options.executable ?? process.execPath;
    const run = options.run ?? runServiceCommandEffect;
    const definition = serviceDefinition(platform, command, role, home);
    const fs = yield* FileSystem.FileSystem;
    let launcherRollback = Effect.void;
    if (platform === "darwin") {
      const launcher = serviceLauncherPath(role, home);
      const temporary = `${launcher}.${process.pid}.tmp`;
      yield* fs.makeDirectory(dirname(launcher), { recursive: true });
      const replaceLauncher = (target: string) =>
        fs
          .remove(temporary, { force: true })
          .pipe(
            Effect.andThen(fs.symlink(target, temporary)),
            Effect.andThen(fs.rename(temporary, launcher)),
            Effect.ensuring(
              fs.remove(temporary, { force: true }).pipe(Effect.catchEager(() => Effect.void)),
            ),
          );
      const previousTarget = yield* fs
        .readLink(launcher)
        .pipe(
          Effect.catchEager((error) =>
            error.reason._tag === "NotFound"
              ? Effect.succeed<string | undefined>(undefined)
              : Effect.fail(error),
          ),
        );
      yield* replaceLauncher(executable);
      launcherRollback = (
        previousTarget === undefined
          ? fs.remove(launcher, { force: true })
          : replaceLauncher(previousTarget)
      ).pipe(Effect.orDie);
    }
    return yield* Effect.gen(function* () {
      yield* fs.makeDirectory(dirname(definition.path), { recursive: true });
      yield* fs.writeFile(definition.path, new TextEncoder().encode(definition.content), {
        mode: 0o600,
      });
      if (platform === "darwin") {
        yield* run(
          ["launchctl", "bootout", `gui/${process.getuid?.() ?? 0}/com.qujing.${role}`],
          true,
        );
        yield* run(["launchctl", "bootstrap", `gui/${process.getuid?.() ?? 0}`, definition.path]);
      } else {
        yield* run(["systemctl", "--user", "daemon-reload"]);
        yield* run(["systemctl", "--user", "enable", "--now", `qujing-${role}.service`]);
      }
      return definition.path;
    }).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? launcherRollback : Effect.void)));
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
          ["launchctl", "bootout", `gui/${process.getuid?.() ?? 0}/com.qujing.${role}`],
          true,
        );
        yield* operations.remove(definition.path);
        yield* operations.remove(serviceLauncherPath(role));
      } else {
        yield* operations.run(
          ["systemctl", "--user", "disable", "--now", `qujing-${role}.service`],
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
      yield* runServiceCommandEffect(
        ["launchctl", "bootout", `gui/${process.getuid?.() ?? 0}/com.qujing.${role}`],
        true,
      );
      yield* fs.remove(definition.path, { force: true });
      yield* fs.remove(serviceLauncherPath(role), { force: true });
    } else {
      yield* runServiceCommandEffect(
        ["systemctl", "--user", "disable", "--now", `qujing-${role}.service`],
        true,
      );
      yield* fs.remove(definition.path, { force: true });
      yield* runServiceCommandEffect(["systemctl", "--user", "daemon-reload"]);
    }
    return definition.path;
  }).pipe(Effect.provide(PlatformLayer));
};
export function serviceLauncherPath(role: ServiceRole, home = homedir()): string {
  return join(home, "Library", "Application Support", "Qujing", "bin", `qujing-${role}`);
}
export function currentServeCommand(
  role: ServiceRole,
  platform: NodeJS.Platform = process.platform,
  executable = process.execPath,
  script = process.argv[1],
): string[] {
  const program = platform === "darwin" ? serviceLauncherPath(role) : executable;
  return script?.endsWith(".ts") ? [program, script, "serve", role] : [program, "serve", role];
}
export const runServiceCommandEffect = (command: string[], allowFailure = false) =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* ChildProcess.make(command[0]!, command.slice(1), {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      const code = Number(yield* handle.exitCode);
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
