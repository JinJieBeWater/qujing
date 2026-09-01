import { homedir } from "node:os";
import { join } from "node:path";

export function defaultPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  if (platform === "win32") {
    const configHome = env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    const dataHome = env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return {
      configPath: join(configHome, "ColleagueLine", "config.json"),
      stateRoot: join(dataHome, "ColleagueLine"),
    };
  }
  return {
    configPath: join(
      env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
      "colleague-line",
      "config.json",
    ),
    stateRoot: join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "colleague-line"),
  };
}

export function defaultClientPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  if (platform === "win32") {
    const configHome = env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    const dataHome = env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return {
      clientConfigPath: join(configHome, "ColleagueLine", "client.json"),
      clientStateRoot: join(dataHome, "ColleagueLine", "client"),
    };
  }
  return {
    clientConfigPath: join(
      env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
      "colleague-line",
      "client.json",
    ),
    clientStateRoot: join(
      env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
      "colleague-line",
      "client",
    ),
  };
}
