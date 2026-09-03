import { homedir } from "node:os";
import { join } from "node:path";

export function defaultPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  const roots = defaultRoots(env, platform);
  return { configPath: join(roots.config, "config.json"), stateRoot: roots.state };
}

export function defaultClientPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  const roots = defaultRoots(env, platform);
  return {
    clientConfigPath: join(roots.config, "client.json"),
    clientStateRoot: join(roots.state, "client"),
  };
}

function defaultRoots(env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  if (platform === "win32") {
    const configHome = env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    const dataHome = env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return {
      config: join(configHome, "Qujing"),
      state: join(dataHome, "Qujing"),
    };
  }
  return {
    config: join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "qujing"),
    state: join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "qujing"),
  };
}
