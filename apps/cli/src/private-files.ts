import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

interface LockOwner {
  pid: number;
  nonce: string;
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  await securePrivatePath(path, true);
}

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const parent = dirname(path);
  await ensurePrivateDirectory(parent);
  const temporary = join(parent, `.${randomUUID()}.tmp`);
  try {
    let handle = await open(temporary, "wx", 0o600);
    if (process.platform === "win32") {
      await handle.close();
      await securePrivatePath(temporary, false);
      handle = await open(temporary, "r+");
    }
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporary, 0o600);
    await securePrivatePath(temporary, false);
    await rename(temporary, path);
    await chmod(path, 0o600);
    await securePrivatePath(path, false);
    await syncDirectory(parent);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function securePrivatePath(path: string, directory: boolean): Promise<void> {
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

export async function isPrivatePath(path: string, directory?: boolean): Promise<boolean> {
  try {
    await assertPrivatePath(path, directory);
    return true;
  } catch {
    return false;
  }
}

export async function assertPrivatePath(path: string, directory?: boolean): Promise<void> {
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

export async function assertPrivateTree(root: string): Promise<void> {
  await assertPrivatePath(root, true);
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      await assertPrivatePath(path);
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

export async function withFileLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const release = await acquirePrivateLock(`${path}.lock`, {
    wait: true,
    timeoutMs: 30_000,
    busyMessage: `Timed out waiting for config lock: ${path}`,
  });
  try {
    return await operation();
  } finally {
    await release();
  }
}

export async function acquirePrivateLock(
  path: string,
  options: { wait: boolean; timeoutMs?: number; busyMessage: string },
): Promise<() => Promise<void>> {
  await ensurePrivateDirectory(dirname(path));
  const owner: LockOwner = { pid: process.pid, nonce: randomUUID() };
  const recovering = `${path}.recovering`;
  const started = Date.now();
  for (;;) {
    if (await pathExists(recovering)) {
      await repairInterruptedRecovery(path, recovering);
      if (!(await pathExists(recovering))) continue;
      await waitForLock(options, started);
      continue;
    }
    try {
      await createOwnedLock(path, owner);
      await rm(recovering, { recursive: true, force: true });
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

export async function privateLockActive(path: string): Promise<boolean> {
  const owner = await readLockOwner(path);
  return owner !== undefined && processExists(owner.pid);
}

export async function privateLockPending(path: string): Promise<boolean> {
  return (
    (await pathExists(path)) &&
    (await readLockOwner(path)) === undefined &&
    (await pathAge(path)) < 1_000
  );
}

async function createOwnedLock(path: string, owner: LockOwner): Promise<void> {
  await mkdir(path, { mode: 0o700 });
  try {
    await chmod(path, 0o700);
    await securePrivatePath(path, true);
    await writePrivateJson(join(path, "owner.json"), owner);
  } catch (error) {
    await rm(path, { recursive: true, force: true });
    throw error;
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
  if (!(await pathExists(path))) {
    await rename(recovering, path).catch(() => {});
    return;
  }
  const current = await readLockOwner(path);
  if (current && processExists(current.pid)) return;
  if (!current && (await pathAge(path)) < 1_000) return;
  await rm(recovering, { recursive: true, force: true });
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
    const parsed = JSON.parse(await readFile(ownerPath, "utf8")) as Partial<LockOwner>;
    return Number.isInteger(parsed.pid) && typeof parsed.nonce === "string"
      ? (parsed as LockOwner)
      : undefined;
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

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
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
