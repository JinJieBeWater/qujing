import { join } from "node:path";
import { Effect } from "effect";
import { sleep } from "./effect-runtime";
import {
  acquirePrivateLockEffect,
  privateLockActiveEffect,
  privateLockPendingEffect,
} from "./private-files";

export function acquireProcessLockEffect(
  path: string,
  busyMessage = "Qujing Node is already running",
): Effect.Effect<Effect.Effect<void, unknown>, unknown> {
  return acquirePrivateLockEffect(path, { wait: false, busyMessage });
}

export function acquireNodeLockEffect(stateRoot: string) {
  return Effect.gen(function* () {
    const release = yield* acquireProcessLockEffect(join(stateRoot, "node.lock"));
    if (!(yield* processLockActiveEffect(join(stateRoot, "maintenance.lock")))) return release;
    yield* release;
    return yield* Effect.fail(new Error("Qujing maintenance is in progress"));
  });
}

export function acquireMaintenanceLockEffect(stateRoot: string) {
  return Effect.gen(function* () {
    const release = yield* acquireProcessLockEffect(
      join(stateRoot, "maintenance.lock"),
      "Qujing maintenance is already running",
    );
    if (!(yield* processLockActiveEffect(join(stateRoot, "node.lock")))) return release;
    yield* release;
    return yield* Effect.fail(new Error("Qujing Node is already running"));
  });
}

export function processLockActiveEffect(path: string) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (yield* privateLockActiveEffect(path)) return true;
      const [pending, recovering] = yield* Effect.all(
        [privateLockPendingEffect(path), privateLockPendingEffect(`${path}.recovering`)],
        { concurrency: "unbounded" },
      );
      if (!pending && !recovering) return yield* privateLockActiveEffect(path);
      yield* sleep(25);
    }
    return false;
  });
}
