import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { removeUserServiceEffect } from "../src/service";
import { createTransportKeyEffect } from "../src/transport/process";
import { TailcatSupervisor } from "../src/transport/supervisor";

it.effect("runs service removal through Effect", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    yield* removeUserServiceEffect("agent", "linux", {
      run: (command) => Effect.sync(() => void events.push(command.join(" "))),
      remove: () => Effect.sync(() => void events.push("remove")),
    });
    expect(events).toEqual([
      "systemctl --user disable --now qujing-agent.service",
      "remove",
      "systemctl --user daemon-reload",
    ]);
  }),
);

it.effect("runs transport readiness through Effect", () =>
  Effect.gen(function* () {
    const root = yield* promise(() => mkdtemp(join(tmpdir(), "qujing-transport-effect-")));
    const binary = join(root, "fake-transport");
    try {
      yield* promise(() =>
        writeFile(
          binary,
          '#!/bin/sh\necho \'{"ready":true,"publicKey":"nodekey:test","keyPath":"/tmp/key"}\'\n',
        ),
      );
      yield* promise(() => chmod(binary, 0o700));
      expect(yield* createTransportKeyEffect(join(root, "key"), binary)).toEqual({
        publicKey: "nodekey:test",
        keyPath: "/tmp/key",
      });
    } finally {
      yield* promise(() => rm(root, { recursive: true, force: true }));
    }
  }),
);

it.effect("serializes supervisor reload through Effect", () =>
  Effect.gen(function* () {
    const root = yield* promise(() => mkdtemp(join(tmpdir(), "qujing-supervisor-effect-")));
    const supervisor = new TailcatSupervisor({
      stateRoot: root,
      port: 43_110,
      startEffect: () =>
        Effect.succeed({
          ready: { ready: true, serverAddress: "tc-stable", remotePort: 43_110 },
          exitedEffect: Effect.never,
          closeEffect: () => Effect.void,
        }),
    });
    try {
      expect(yield* supervisor.reloadEffect([])).toEqual({
        serverAddress: "tc-stable",
        remotePort: 43_110,
      });
      yield* supervisor.closeEffect();
    } finally {
      yield* promise(() => rm(root, { recursive: true, force: true }));
    }
  }),
);

function promise<A>(try_: () => Promise<A>) {
  return Effect.tryPromise({ try: try_, catch: (error) => error });
}
