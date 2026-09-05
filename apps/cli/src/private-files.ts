import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { decode, LockOwner as LockOwnerSchema, type LockOwner as LockOwnerData } from "./schemas";

const parseLockOwner = decode(LockOwnerSchema);
type LockOwner = LockOwnerData;

export const ensurePrivateDirectoryEffect = (path: string) =>
  fromPromise(() => ensurePrivateDirectoryNode(path));

async function ensurePrivateDirectoryNode(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  await securePrivatePathNode(path, true);
}

export const writePrivateJsonEffect = (path: string, value: unknown) =>
  fromPromise(() => writePrivateJsonNode(path, value));

export const writeNewPrivateJsonEffect = (path: string, value: unknown) =>
  fromPromise(() => writeNewPrivateJsonNode(path, value));

async function writePrivateJsonNode(path: string, value: unknown): Promise<void> {
  const parent = dirname(path);
  await ensurePrivateDirectoryNode(parent);
  const temporary = join(parent, `.${randomUUID()}.tmp`);
  try {
    await writeNewJsonFileNode(temporary, value);
    await rename(temporary, path);
    await chmod(path, 0o600);
    await securePrivatePathNode(path, false);
    await syncDirectory(parent);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function writeNewPrivateJsonNode(path: string, value: unknown): Promise<void> {
  const parent = dirname(path);
  await ensureOutputDirectoryNode(parent);
  const staged = join(parent, `.${randomUUID()}.new`);
  let linked = false;
  try {
    await writeNewJsonFileNode(staged, value);
    await link(staged, path);
    linked = true;
    await chmod(path, 0o600);
    await securePrivatePathNode(path, false);
    await syncDirectory(parent);
  } catch (error) {
    if (linked) await rm(path, { force: true }).catch(() => {});
    throw error;
  } finally {
    await rm(staged, { force: true }).catch(() => {});
  }
}

async function ensureOutputDirectoryNode(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error(`Pairing output parent must be a directory: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await ensurePrivateDirectoryNode(path);
  }
}

async function writeNewJsonFileNode(path: string, value: unknown): Promise<void> {
  let handle = await open(path, "wx", 0o600);
  if (process.platform === "win32") {
    await handle.close();
    await securePrivatePathNode(path, false);
    handle = await open(path, "r+");
  }
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
  await securePrivatePathNode(path, false);
}

export const securePrivatePathEffect = (path: string, directory: boolean) =>
  fromPromise(() => securePrivatePathNode(path, directory));

async function securePrivatePathNode(path: string, directory: boolean): Promise<void> {
  if (process.platform !== "win32") return;
  const script = String.raw`param([string]$Path,[string]$Kind)
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User
$acl = Get-Acl -LiteralPath $Path
$acl.SetAccessRuleProtection($true, $false)
foreach ($existing in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($existing) }
if ($Kind -eq 'directory') {
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
} else {
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
}
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $Path -AclObject $acl`;
  await runPowerShell(
    script,
    [path, directory ? "directory" : "file"],
    `Could not secure Windows ACL: ${path}`,
  );
}

export const isPrivatePathEffect = (path: string, directory?: boolean) =>
  assertPrivatePathEffect(path, directory).pipe(
    Effect.as(true),
    Effect.catchEager(() => Effect.succeed(false)),
  );

export const assertPrivatePathEffect = (path: string, directory?: boolean) =>
  fromPromise(() => assertPrivatePathNode(path, directory));

async function assertPrivatePathNode(path: string, directory?: boolean): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`Private state path must not be a symlink: ${path}`);
  if (directory !== undefined && info.isDirectory() !== directory)
    throw new Error(`Private state path has wrong type: ${path}`);
  if (!info.isDirectory() && !info.isFile())
    throw new Error(`Private state path has unsupported type: ${path}`);
  if (process.platform !== "win32") {
    const expected = info.isDirectory() ? 0o700 : 0o600;
    if ((info.mode & 0o777) !== expected)
      throw new Error(`Private state permissions must be ${expected.toString(8)}: ${path}`);
    const uid = process.getuid?.();
    if (uid !== undefined && info.uid !== uid)
      throw new Error(`Private state must be owned by the current user: ${path}`);
    return;
  }
  await assertWindowsAcl(path);
}

export const assertPrivateTreeEffect = (root: string) =>
  fromPromise(() => assertPrivateTreeNode(root));

async function assertPrivateTreeNode(root: string): Promise<void> {
  await assertPrivatePathNode(root, true);
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      await assertPrivatePathNode(path);
      if (entry.isDirectory()) pending.push(path);
    }
  }
}

async function assertWindowsAcl(path: string): Promise<void> {
  const script = String.raw`param([string]$Path)
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$acl = Get-Acl -LiteralPath $Path
$allow = @($acl.Access | Where-Object { $_.AccessControlType -eq 'Allow' })
if ($allow.Count -eq 0) { exit 2 }
foreach ($rule in $allow) {
  if ($rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid) { exit 3 }
}
exit 0`;
  await runPowerShell(script, [path], `Private state ACL is unsafe: ${path}`);
}

async function runPowerShell(script: string, args: string[], message: string): Promise<void> {
  const child = Bun.spawn(
    ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script, ...args],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  if ((await child.exited) !== 0) throw new Error(message);
}

/** Scoped lock primitive. Scope owns release on every success, failure, or interruption path. */
export const withPrivateLock = <A, E, R>(path: string, operation: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        acquirePrivateLockEffect(`${path}.lock`, {
          wait: true,
          timeoutMs: 30_000,
          busyMessage: `Timed out waiting for config lock: ${path}`,
        }),
        (release) => release.pipe(Effect.orDie),
      );
      return yield* operation;
    }),
  );

export const acquirePrivateLockEffect = (
  path: string,
  options: { wait: boolean; timeoutMs?: number; busyMessage: string },
) =>
  fromPromise(() => acquirePrivateLockNode(path, options)).pipe(
    Effect.map((release) => fromPromise(release)),
  );

async function acquirePrivateLockNode(
  path: string,
  options: { wait: boolean; timeoutMs?: number; busyMessage: string },
): Promise<() => Promise<void>> {
  await ensurePrivateDirectoryNode(dirname(path));
  const owner: LockOwner = { pid: process.pid, nonce: randomUUID() };
  const recovering = `${path}.recovering`;
  const started = Date.now();
  for (;;) {
    if (await pathExists(recovering)) {
      if ((await pathAge(recovering)) < 1_000) {
        await waitForLock(options, started);
        continue;
      }
      await repairInterruptedRecovery(path, recovering);
      continue;
    }
    try {
      await createOwnedLock(path, owner);
      return lockRelease(path, owner);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const current = await readLockOwner(path);
    if (current && processExists(current.pid)) {
      await waitForLock(options, started);
      continue;
    }
    if (!current && (await pathAge(path)) < 1_000) {
      await waitForIncompleteLock(options.busyMessage, started);
      continue;
    }
    try {
      await rename(path, recovering);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "ENOENT" ||
        (error as NodeJS.ErrnoException).code === "EEXIST" ||
        (error as NodeJS.ErrnoException).code === "ENOTEMPTY" ||
        (error as NodeJS.ErrnoException).code === "ENOTDIR" ||
        (error as NodeJS.ErrnoException).code === "EISDIR"
      )
        continue;
      throw error;
    }
    const moved = await readLockOwner(recovering);
    if (moved?.nonce !== current?.nonce) {
      await rename(recovering, path).catch(() => {});
      continue;
    }
    try {
      await createOwnedLock(path, owner);
      await rm(recovering, { recursive: true, force: true });
      return lockRelease(path, owner);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        await rm(recovering, { recursive: true, force: true });
        await waitForLock(options, started);
        continue;
      }
      await rename(recovering, path).catch(() => {});
      throw error;
    }
  }
}

export const privateLockActiveEffect = (path: string) =>
  fromPromise(() => privateLockActiveNode(path));

async function privateLockActiveNode(path: string): Promise<boolean> {
  const owner = await readLockOwner(path);
  return owner !== undefined && processExists(owner.pid);
}

export const privateLockPendingEffect = (path: string) =>
  fromPromise(() => privateLockPendingNode(path));

async function privateLockPendingNode(path: string): Promise<boolean> {
  return (
    (await pathExists(path)) &&
    (await readLockOwner(path)) === undefined &&
    (await pathAge(path)) < 1_000
  );
}

async function createOwnedLock(path: string, owner: LockOwner): Promise<void> {
  const candidate = `${path}.candidate-${owner.nonce}`;
  try {
    await writePrivateJsonNode(candidate, owner);
    await link(candidate, path);
  } finally {
    await rm(candidate, { force: true }).catch(() => {});
  }
}

function lockRelease(path: string, owner: LockOwner): () => Promise<void> {
  return async () => {
    if ((await readLockOwner(path))?.nonce !== owner.nonce) return;
    const released = `${path}.released-${owner.nonce}`;
    try {
      await rename(path, released);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await rm(released, { recursive: true, force: true });
  };
}

async function repairInterruptedRecovery(path: string, recovering: string): Promise<void> {
  if (await pathExists(path)) {
    await rm(recovering, { recursive: true, force: true });
    return;
  }
  await rename(recovering, path).catch(() => {});
}

async function waitForLock(
  options: { wait: boolean; timeoutMs?: number; busyMessage: string },
  started: number,
): Promise<void> {
  if (!options.wait || Date.now() - started >= (options.timeoutMs ?? 0))
    throw new Error(options.busyMessage);
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function waitForIncompleteLock(message: string, started: number): Promise<void> {
  if (Date.now() - started >= 1_000) throw new Error(message);
  await new Promise((resolve) => setTimeout(resolve, 25));
}

async function readLockOwner(path: string): Promise<LockOwner | undefined> {
  try {
    const info = await lstat(path);
    const ownerPath = info.isDirectory() ? join(path, "owner.json") : path;
    return parseLockOwner(JSON.parse(await readFile(ownerPath, "utf8")));
  } catch {
    return undefined;
  }
}

async function pathAge(path: string): Promise<number> {
  return lstat(path)
    .then((info) => Date.now() - info.mtimeMs)
    .catch(() => 0);
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function fromPromise<A>(try_: () => Promise<A>) {
  return Effect.tryPromise({ try: try_, catch: (error) => error });
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
