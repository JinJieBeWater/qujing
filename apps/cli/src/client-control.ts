import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { ClientApplication, lineFingerprint } from "./client-application";
import type { ClientConfig, LineConfig } from "./client-config";
import { sleep } from "./effect-runtime";
import { configFingerprint } from "./gateway-reload";
import { writePrivateJsonEffect } from "./private-files";
import { processLockActiveEffect } from "./process-lock";
import {
  ClientLineRetirement as ClientLineRetirementSchema,
  ClientLineRetirementAcknowledgement,
  decode,
  type ClientLineRetirement as ClientLineRetirementData,
} from "./schemas";

const parseRequest = decode(ClientLineRetirementSchema);
const parseAcknowledgement = decode(ClientLineRetirementAcknowledgement);

export type ClientLineRetirement = ClientLineRetirementData;

export function requestClientLineRetirementEffect(
  stateRoot: string,
  config: ClientConfig,
  line: LineConfig,
): Effect.Effect<ClientLineRetirement, unknown> {
  return Effect.gen(function* () {
    const request = parseRequest({
      version: 1,
      id: randomUUID(),
      lineId: line.id,
      lineFingerprint: lineFingerprint(line),
      configFingerprint: configFingerprint(config),
      requesterPid: process.pid,
      createdAt: new Date().toISOString(),
    });
    yield* promise(() => rm(acknowledgementPath(stateRoot), { force: true }));
    yield* writePrivateJsonEffect(requestPath(stateRoot), request);
    return request;
  });
}

export function cancelClientLineRetirementEffect(
  stateRoot: string,
  request: ClientLineRetirement,
): Effect.Effect<void, unknown> {
  return writePrivateJsonEffect(requestPath(stateRoot), { ...request, cancelled: true });
}

export function waitForClientLineRetirementEffect(
  stateRoot: string,
  request: ClientLineRetirement,
  timeoutMs = 45_000,
): Effect.Effect<boolean, unknown> {
  const deadline = Date.now() + timeoutMs;
  return Effect.gen(function* () {
    for (;;) {
      const acknowledgement = yield* promise(() => readAcknowledgement(stateRoot));
      if (acknowledgement?.requestId === request.id) return true;
      if (!(yield* processLockActiveEffect(join(stateRoot, "client.lock")))) return false;
      if (Date.now() >= deadline)
        return yield* Effect.fail(new Error("Timed out waiting for Client Line retirement"));
      yield* sleep(50);
    }
  });
}

export function processClientLineRetirementEffect(
  stateRoot: string,
  config: ClientConfig,
  app: ClientApplication,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const request = yield* promise(() => readRequest(stateRoot));
    if (!request) return;
    if (
      request.cancelled ||
      request.configFingerprint !== configFingerprint(config) ||
      !processExists(request.requesterPid)
    ) {
      yield* app.resumeLineEffect(request.lineId, request.lineFingerprint);
      yield* promise(() => clearControl(stateRoot));
      return;
    }
    const acknowledgement = yield* promise(() => readAcknowledgement(stateRoot));
    if (acknowledgement?.requestId === request.id) return;
    yield* app.retireLineEffect(request.lineId, request.lineFingerprint);
    yield* writePrivateJsonEffect(acknowledgementPath(stateRoot), {
      requestId: request.id,
      updatedAt: new Date().toISOString(),
    });
  });
}

async function readRequest(stateRoot: string): Promise<ClientLineRetirement | undefined> {
  return readJson(requestPath(stateRoot), parseRequest);
}

async function readAcknowledgement(stateRoot: string) {
  return readJson(acknowledgementPath(stateRoot), parseAcknowledgement);
}

async function readJson<T>(path: string, parse: (input: unknown) => T): Promise<T | undefined> {
  try {
    return parse(JSON.parse(await readFile(path, "utf8")));
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

function promise<A>(try_: () => Promise<A>) {
  return Effect.tryPromise({ try: try_, catch: (error) => error });
}
