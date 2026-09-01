import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
  if (platform === "darwin") {
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
  }
  if (platform === "linux") {
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
  }
  throw new Error(`User service installation is unsupported on ${platform}`);
}

export async function installUserService(command: string[], role: ServiceRole): Promise<string> {
  const definition = serviceDefinition(process.platform, command, role);
  await mkdir(dirname(definition.path), { recursive: true });
  await writeFile(definition.path, definition.content, { mode: 0o600 });
  if (process.platform === "darwin") {
    await run(
      ["launchctl", "bootout", `gui/${process.getuid?.() ?? 0}/com.colleague-line.${role}`],
      true,
    );
    await run(["launchctl", "bootstrap", `gui/${process.getuid?.() ?? 0}`, definition.path]);
  } else {
    await run(["systemctl", "--user", "daemon-reload"]);
    await run(["systemctl", "--user", "enable", "--now", `colleague-line-${role}.service`]);
  }
  return definition.path;
}

interface RemoveServiceOperations {
  run(command: string[], allowFailure?: boolean): Promise<void>;
  remove(path: string): Promise<void>;
}

export async function removeUserService(
  role: ServiceRole,
  platform: NodeJS.Platform = process.platform,
  operations: RemoveServiceOperations = {
    run,
    remove: (path) => rm(path, { force: true }),
  },
): Promise<string> {
  const definition = serviceDefinition(platform, currentServeCommand(role), role);
  if (platform === "darwin") {
    await operations.run(
      ["launchctl", "bootout", `gui/${process.getuid?.() ?? 0}/com.colleague-line.${role}`],
      true,
    );
    await operations.remove(definition.path);
  } else {
    await operations.run(
      ["systemctl", "--user", "disable", "--now", `colleague-line-${role}.service`],
      true,
    );
    await operations.remove(definition.path);
    await operations.run(["systemctl", "--user", "daemon-reload"]);
  }
  return definition.path;
}

export function currentServeCommand(role: ServiceRole): string[] {
  const script = process.argv[1];
  return script?.endsWith(".ts")
    ? [process.execPath, script, role, "serve"]
    : [process.execPath, role, "serve"];
}

async function run(command: string[], allowFailure = false): Promise<void> {
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const code = await child.exited;
  if (code !== 0 && !allowFailure) throw new Error(`${command[0]} exited ${code}`);
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
