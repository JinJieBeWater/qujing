import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TailcatSupervisor } from "../src/transport/supervisor";
import type { TransportProcess } from "../src/transport/process";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

describe("TailcatSupervisor", () => {
  test("restarts transport only when allowlist changes and keeps server address stable", async () => {
    const root = await mkdtemp(join(tmpdir(), "colleague-line-tailcat-"));
    roots.push(root);
    const starts: string[][] = [];
    let closes = 0;
    const start = async (options: { allowedKeys: string[] }): Promise<TransportProcess> => {
      starts.push(options.allowedKeys);
      return {
        ready: { ready: true, serverAddress: "tc-stable", remotePort: 43_110 },
        exited: new Promise(() => {}),
        close: async () => {
          closes++;
        },
      };
    };
    const supervisor = new TailcatSupervisor({ stateRoot: root, port: 43_110, start });

    await supervisor.reload([]);
    await supervisor.reload([]);
    await supervisor.reload(["nodekey:a"]);
    expect(starts).toEqual([[], ["nodekey:a"]]);
    expect(closes).toBe(1);
    expect((await supervisor.state()).serverAddress).toBe("tc-stable");
    expect((await stat(join(root, "transport", "server.json"))).mode & 0o777).toBe(0o600);
    await supervisor.close();
    expect(closes).toBe(2);
  });

  test("rejects a changed server address after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "colleague-line-tailcat-"));
    roots.push(root);
    let count = 0;
    const supervisor = new TailcatSupervisor({
      stateRoot: root,
      port: 43_110,
      start: async () => ({
        ready: { ready: true, serverAddress: `tc-${++count}`, remotePort: 43_110 },
        exited: new Promise(() => {}),
        close: async () => {},
      }),
    });
    await supervisor.reload([]);
    await expect(supervisor.reload(["nodekey:a"])).rejects.toThrow("address changed");
  });

  test("does not treat an intentional reload exit as fatal", async () => {
    const root = await mkdtemp(join(tmpdir(), "colleague-line-tailcat-"));
    roots.push(root);
    const failures: string[] = [];
    const supervisor = new TailcatSupervisor({
      stateRoot: root,
      port: 43_110,
      onFatal: (error) => failures.push(error.message),
      start: async () => {
        let resolveExit!: (code: number) => void;
        const exited = new Promise<number>((resolve) => {
          resolveExit = resolve;
        });
        return {
          ready: { ready: true, serverAddress: "tc-stable", remotePort: 43_110 },
          exited,
          close: async () => {
            resolveExit(0);
            await exited;
          },
        };
      },
    });

    await supervisor.reload([]);
    await supervisor.reload(["nodekey:a"]);
    expect(failures).toEqual([]);
    await supervisor.close();
    expect(failures).toEqual([]);
  });
});
