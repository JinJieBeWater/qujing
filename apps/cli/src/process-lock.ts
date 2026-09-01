import { dirname, join } from "node:path";
import {
  acquirePrivateLock,
  ensurePrivateDirectory,
  privateLockActive,
  privateLockPending,
} from "./private-files";

export async function acquireProcessLock(
  path: string,
  busyMessage = "Colleague Line Gateway is already running",
): Promise<() => Promise<void>> {
  await ensurePrivateDirectory(dirname(path));
  return acquirePrivateLock(path, { wait: false, busyMessage });
}

export async function acquireGatewayLock(stateRoot: string): Promise<() => Promise<void>> {
  const release = await acquireProcessLock(join(stateRoot, "gateway.lock"));
  if (!(await processLockActive(join(stateRoot, "maintenance.lock")))) return release;
  await release();
  throw new Error("Colleague Line maintenance is in progress");
}

export async function acquireMaintenanceLock(stateRoot: string): Promise<() => Promise<void>> {
  const release = await acquireProcessLock(
    join(stateRoot, "maintenance.lock"),
    "Colleague Line maintenance is already running",
  );
  if (!(await processLockActive(join(stateRoot, "gateway.lock")))) return release;
  await release();
  throw new Error("Colleague Line Gateway is already running");
}

export async function processLockActive(path: string): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await privateLockActive(path)) return true;
    if (!(await privateLockPending(path)) && !(await privateLockPending(`${path}.recovering`)))
      return privateLockActive(path);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}
