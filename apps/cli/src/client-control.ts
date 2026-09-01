import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ClientApplication, lineFingerprint } from "./client-application";
import type { ClientConfig, LineConfig } from "./client-config";
import { writePrivateJson } from "./private-files";
import { processLockActive } from "./process-lock";

const requestSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  lineId: z.string().min(1),
  lineFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  configFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  requesterPid: z.number().int().positive(),
  createdAt: z.string().datetime(),
  cancelled: z.boolean().optional(),
});
const acknowledgementSchema = z.object({
  requestId: z.string().uuid(),
  updatedAt: z.string().datetime(),
});

export type ClientLineRetirement = z.infer<typeof requestSchema>;

export async function requestClientLineRetirement(
  stateRoot: string,
  config: ClientConfig,
  line: LineConfig,
): Promise<ClientLineRetirement> {
  const request = requestSchema.parse({
    version: 1,
    id: randomUUID(),
    lineId: line.id,
    lineFingerprint: lineFingerprint(line),
    configFingerprint: configFingerprint(config),
    requesterPid: process.pid,
    createdAt: new Date().toISOString(),
  });
  await publishClientLineRetirement(
    () => rm(acknowledgementPath(stateRoot), { force: true }),
    () => writePrivateJson(requestPath(stateRoot), request),
  );
  return request;
}

export async function publishClientLineRetirement(
  removeAcknowledgement: () => Promise<unknown>,
  writeRequest: () => Promise<unknown>,
): Promise<void> {
  await removeAcknowledgement();
  await writeRequest();
}

export async function cancelClientLineRetirement(
  stateRoot: string,
  request: ClientLineRetirement,
): Promise<void> {
  await writePrivateJson(requestPath(stateRoot), { ...request, cancelled: true });
}

export async function waitForClientLineRetirement(
  stateRoot: string,
  request: ClientLineRetirement,
  timeoutMs = 45_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const acknowledgement = await readAcknowledgement(stateRoot);
    if (acknowledgement?.requestId === request.id) return true;
    if (!(await processLockActive(join(stateRoot, "client.lock")))) return false;
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Client Line retirement");
    await Bun.sleep(50);
  }
}

export async function processClientLineRetirement(
  stateRoot: string,
  config: ClientConfig,
  app: ClientApplication,
): Promise<void> {
  const request = await readRequest(stateRoot);
  if (!request) return;
  if (
    request.cancelled ||
    request.configFingerprint !== configFingerprint(config) ||
    !processExists(request.requesterPid)
  ) {
    await app.resumeLine(request.lineId, request.lineFingerprint);
    await clearControl(stateRoot);
    return;
  }
  const acknowledgement = await readAcknowledgement(stateRoot);
  if (acknowledgement?.requestId === request.id) return;
  await app.retireLine(request.lineId, request.lineFingerprint);
  await writePrivateJson(acknowledgementPath(stateRoot), {
    requestId: request.id,
    updatedAt: new Date().toISOString(),
  });
}

export function configFingerprint(config: ClientConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

async function readRequest(stateRoot: string): Promise<ClientLineRetirement | undefined> {
  return readJson(requestPath(stateRoot), requestSchema);
}

async function readAcknowledgement(stateRoot: string) {
  return readJson(acknowledgementPath(stateRoot), acknowledgementSchema);
}

async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
  try {
    return schema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function clearControl(stateRoot: string): Promise<void> {
  await Promise.all([
    rm(requestPath(stateRoot), { force: true }),
    rm(acknowledgementPath(stateRoot), { force: true }),
  ]);
}

function requestPath(stateRoot: string): string {
  return join(stateRoot, "client-line-retirement.json");
}

function acknowledgementPath(stateRoot: string): string {
  return join(stateRoot, "client-line-retirement-ack.json");
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
