import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { removeUserServiceEffect, serviceDefinition } from "../src/service";

describe("role user service definitions", () => {
  test("creates separate restartable macOS LaunchAgents", () => {
    const gateway = serviceDefinition(
      "darwin",
      ["/Applications/Qujing/qj", "serve", "gateway"],
      "gateway",
    );
    const client = serviceDefinition(
      "darwin",
      ["/Applications/Qujing/qj", "serve", "client"],
      "client",
    );
    expect(gateway.path).toContain("com.qujing.gateway.plist");
    expect(client.path).toContain("com.qujing.client.plist");
    expect(gateway.content).toContain("<string>serve</string><string>gateway</string>");
    expect(gateway.content).toContain("<key>KeepAlive</key>");
    expect(gateway.content).toContain("<key>StandardOutPath</key><string>/dev/null</string>");
    expect(gateway.content).not.toContain("sh -c");
  });

  test("creates separate restartable Linux services", () => {
    const definition = serviceDefinition(
      "linux",
      ["/home/alice/Qujing/qj", "serve", "client"],
      "client",
    );
    expect(definition.path).toContain("systemd/user/qujing-client.service");
    expect(definition.content).toContain('ExecStart="/home/alice/Qujing/qj" "serve" "client"');
    expect(definition.content).toContain("Restart=on-failure");
    expect(definition.content).toContain("StandardOutput=null");
  });
});

test("removes Linux unit before daemon reload", async () => {
  const events: string[] = [];
  await Effect.runPromise(
    removeUserServiceEffect("client", "linux", {
      run: (command) => Effect.sync(() => void events.push(command.join(" "))),
      remove: () => Effect.sync(() => void events.push("remove")),
    }),
  );
  expect(events).toEqual([
    "systemctl --user disable --now qujing-client.service",
    "remove",
    "systemctl --user daemon-reload",
  ]);
});
