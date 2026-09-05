import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { AgentApplication, peerFingerprint } from "./agent-application";
import type { AgentConfig, PeerConfig } from "./agent-config";
import { sleep } from "./effect-runtime";
import { configFingerprint } from "./reload";
import { processExists, writePrivateJsonEffect } from "./private-files";
import { processLockActiveEffect } from "./process-lock";
import {
  PeerRetirement as PeerRetirementSchema,
  PeerRetirementAcknowledgement,
  decode,
  type PeerRetirement as PeerRetirementData,
} from "./schemas";

const parseRequest = decode(PeerRetirementSchema);
const parseAcknowledgement = decode(PeerRetirementAcknowledgement);

export type PeerRetirement = PeerRetirementData;

export function requestPeerRetirementEffect(
  stateRoot: string,
  config: AgentConfig,
  peer: PeerConfig,
): Effect.Effect<PeerRetirement, unknown> {
  return Effect.gen(function* () {
    const request = parseRequest({
      version: 1,
      id: randomUUID(),
      peerId: peer.id,
      peerFingerprint: peerFingerprint(peer),
      configFingerprint: configFingerprint(config),
      requesterPid: process.pid,
      createdAt: new Date().toISOString(),
    });
    yield* Effect.tryPromise({
      try: () => rm(acknowledgementPath(stateRoot), { force: true }),
      catch: (error) => error,
    });
    yield* writePrivateJsonEffect(requestPath(stateRoot), request);
    return request;
  });
}

export function cancelPeerRetirementEffect(
  stateRoot: string,
  request: PeerRetirement,
): Effect.Effect<void, unknown> {
  return writePrivateJsonEffect(requestPath(stateRoot), { ...request, cancelled: true });
}

export function waitForPeerRetirementEffect(
  stateRoot: string,
  request: PeerRetirement,
  timeoutMs = 45_000,
): Effect.Effect<boolean, unknown> {
  const deadline = Date.now() + timeoutMs;
  return Effect.gen(function* () {
    for (;;) {
      const acknowledgement = yield* Effect.tryPromise({
        try: () => readAcknowledgement(stateRoot),
        catch: (error) => error,
      });
      if (acknowledgement?.requestId === request.id) return true;
      if (!(yield* processLockActiveEffect(join(stateRoot, "agent.lock")))) return false;
      if (Date.now() >= deadline)
        return yield* Effect.fail(new Error("Timed out waiting for Agent Peer retirement"));
      yield* sleep(50);
    }
  });
}

export function processPeerRetirementEffect(
  stateRoot: string,
  config: AgentConfig,
  app: AgentApplication,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const request = yield* Effect.tryPromise({
      try: () => readRequest(stateRoot),
      catch: (error) => error,
    });
    if (!request) return;
    if (
      request.cancelled ||
      request.configFingerprint !== configFingerprint(config) ||
      !processExists(request.requesterPid)
    ) {
      yield* app.resumePeerEffect(request.peerId, request.peerFingerprint);
      yield* Effect.tryPromise({ try: () => clearControl(stateRoot), catch: (error) => error });
      return;
    }
    const acknowledgement = yield* Effect.tryPromise({
      try: () => readAcknowledgement(stateRoot),
      catch: (error) => error,
    });
    if (acknowledgement?.requestId === request.id) return;
    yield* app.retirePeerEffect(request.peerId, request.peerFingerprint);
    yield* writePrivateJsonEffect(acknowledgementPath(stateRoot), {
      requestId: request.id,
      updatedAt: new Date().toISOString(),
    });
  });
}

async function readRequest(stateRoot: string): Promise<PeerRetirement | undefined> {
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
  return join(stateRoot, "agent-peer-retirement.json");
}

function acknowledgementPath(stateRoot: string): string {
  return join(stateRoot, "agent-peer-retirement-ack.json");
}
