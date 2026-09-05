import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect } from "effect";
import { createBearer, hashBearer, sameBearerHash } from "./credentials";
import {
  assertPrivatePathEffect,
  ensurePrivateDirectoryEffect,
  withPrivateLock,
  writePrivateJsonEffect,
} from "./private-files";
import {
  AgentConfig as AgentConfigSchema,
  decode,
  Identifier,
  Peer as PeerSchema,
  PeerCredentials as PeerCredentialsSchema,
  PeerInput as PeerInputSchema,
  type AgentConfig as AgentConfigData,
  type Peer as PeerData,
  type PeerInput as PeerInputData,
} from "./schemas";

const parseConfig = decode(AgentConfigSchema);
const parseIdentifier = decode(Identifier);
const parsePeer = decode(PeerSchema);
const parsePeerInput = decode(PeerInputSchema);
const parsePeerCredentials = decode(PeerCredentialsSchema);

export type AgentConfig = AgentConfigData;
export type PeerConfig = PeerData;
export type PeerInput = PeerInputData;
export type PublicPeer = Pick<
  PeerConfig,
  "id" | "expectedNodeId" | "remoteAgentId" | "remotePort" | "createdAt" | "updatedAt"
>;
export const LOCAL_AGENT_ID = "local-agent";
export interface AgentConfigStorePaths {
  configPath: string;
}
export type AgentInitResult =
  | { initialized: true; bearer: string }
  | { initialized: false; alreadyInitialized: true };

export class AgentConfigStore {
  constructor(readonly paths: AgentConfigStorePaths) {}

  initEffect(input: { port?: number } = {}) {
    return Effect.gen({ self: this }, function* () {
      yield* ensurePrivateDirectoryEffect(dirname(this.paths.configPath));
      return yield* this.withLockEffect(
        this.readEffect().pipe(
          Effect.matchEffect({
            onFailure: (error) => {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") return Effect.fail(error);
              const bearer = createBearer();
              return this.writeJsonEffect(
                parseConfig({
                  version: 1,
                  server: { host: "127.0.0.1", port: input.port ?? 43_111 },
                  localBearerHash: hashBearer(bearer),
                  peers: [],
                }),
              ).pipe(Effect.as({ initialized: true as const, bearer }));
            },
            onSuccess: (current) =>
              input.port !== undefined && current.server.port !== input.port
                ? Effect.fail(new Error("Agent is already initialized with a different port"))
                : Effect.succeed({
                    initialized: false as const,
                    alreadyInitialized: true as const,
                  }),
          }),
        ),
      );
    });
  }

  readEffect() {
    return Effect.gen({ self: this }, function* () {
      yield* assertPrivatePathEffect(dirname(this.paths.configPath), true);
      yield* assertPrivatePathEffect(this.paths.configPath, false);
      const text = yield* this.privateOperation(() => readFile(this.paths.configPath, "utf8"));
      return yield* Effect.try({
        try: () => parseConfig(JSON.parse(text)),
        catch: (error) => error,
      });
    });
  }

  rotateLocalBearerEffect() {
    return this.withLockEffect(
      Effect.gen({ self: this }, function* () {
        const config = yield* this.readEffect();
        const bearer = createBearer();
        yield* this.writeJsonEffect(
          parseConfig({ ...config, localBearerHash: hashBearer(bearer) }),
        );
        return { bearer };
      }),
    );
  }

  authenticateLocalEffect(bearer: string) {
    return Effect.gen({ self: this }, function* () {
      const config = yield* this.readEffect();
      return sameBearerHash(config.localBearerHash, hashBearer(bearer))
        ? { id: LOCAL_AGENT_ID, credentialVersion: config.localBearerHash }
        : undefined;
    });
  }

  validateEffect(input: PeerInput) {
    return this.validatePeerEffect(input).pipe(Effect.map(({ peer }) => peer));
  }

  addEffect(input: PeerInput) {
    return Effect.gen({ self: this }, function* () {
      const { peer, fingerprint } = yield* this.validatePeerEffect(input);
      yield* this.withLockEffect(
        Effect.gen({ self: this }, function* () {
          const config = yield* this.readEffect();
          const existing = config.peers.find(({ id }) => id === peer.id);
          if (existing) {
            const { createdAt: _createdAt, updatedAt: _updatedAt, ...comparable } = existing;
            if (JSON.stringify(comparable) === JSON.stringify(peer)) return;
            throw new Error(`Peer already exists with different configuration: ${peer.id}`);
          }
          yield* this.assertDistinctCredentialsEffect(
            config.peers,
            peer.id,
            peer.remoteBearer,
            fingerprint,
          );
          const now = new Date().toISOString();
          yield* this.writeJsonEffect(
            parseConfig({
              ...config,
              peers: [...config.peers, parsePeer({ ...peer, createdAt: now, updatedAt: now })],
            }),
          );
        }),
      );
    });
  }

  listEffect() {
    return this.readEffect().pipe(
      Effect.map((config) =>
        config.peers.map(
          ({ id, expectedNodeId, remoteAgentId, remotePort, createdAt, updatedAt }) => ({
            id,
            expectedNodeId,
            remoteAgentId,
            remotePort,
            createdAt,
            updatedAt,
          }),
        ),
      ),
    );
  }

  getEffect(id: string) {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.sync(() => parseIdentifier(id));
      return (yield* this.readEffect()).peers.find((peer) => peer.id === id);
    });
  }

  validateCredentialsEffect(input: Pick<PeerConfig, "keyPath" | "remoteBearer">) {
    return this.validateCredentialInputEffect(input).pipe(
      Effect.map(({ credentials }) => credentials),
    );
  }

  updateCredentialsEffect(id: string, update: Pick<PeerConfig, "keyPath" | "remoteBearer">) {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.sync(() => parseIdentifier(id));
      const { credentials, fingerprint } = yield* this.validateCredentialInputEffect(update);
      yield* this.withLockEffect(
        Effect.gen({ self: this }, function* () {
          const config = yield* this.readEffect();
          if (!config.peers.some((entry) => entry.id === id))
            throw new Error(`Peer not found: ${id}`);
          yield* this.assertDistinctCredentialsEffect(
            config.peers,
            id,
            credentials.remoteBearer,
            fingerprint,
          );
          yield* this.writeJsonEffect(
            parseConfig({
              ...config,
              peers: config.peers.map((peer) =>
                peer.id === id
                  ? { ...peer, ...credentials, updatedAt: new Date().toISOString() }
                  : peer,
              ),
            }),
          );
        }),
      );
    });
  }

  removeEffect(id: string) {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.sync(() => parseIdentifier(id));
      return yield* this.withLockEffect(
        Effect.gen({ self: this }, function* () {
          const config = yield* this.readEffect();
          const peers = config.peers.filter((peer) => peer.id !== id);
          if (peers.length === config.peers.length) return false;
          yield* this.writeJsonEffect(parseConfig({ ...config, peers }));
          return true;
        }),
      );
    });
  }

  private validatePeerEffect(input: PeerInput) {
    return Effect.gen({ self: this }, function* () {
      const peer = yield* Effect.sync(() => parsePeerInput(input));
      return { peer, fingerprint: yield* this.validateKeyEffect(peer.keyPath) };
    });
  }
  private validateCredentialInputEffect(input: Pick<PeerConfig, "keyPath" | "remoteBearer">) {
    return Effect.gen({ self: this }, function* () {
      const credentials = yield* Effect.sync(() => parsePeerCredentials(input));
      return { credentials, fingerprint: yield* this.validateKeyEffect(credentials.keyPath) };
    });
  }
  private validateKeyEffect(path: string) {
    return Effect.gen(function* () {
      const key = yield* Effect.tryPromise({
        try: () => stat(path),
        catch: () => new Error(`Peer key not found: ${path}`),
      });
      if (!key.isFile()) throw new Error(`Peer key is not a file: ${path}`);
      yield* assertPrivatePathEffect(path, false).pipe(
        Effect.mapError(() => new Error(`Peer key permissions must be 0600: ${path}`)),
      );
      const contents = yield* Effect.tryPromise({
        try: () => readFile(path),
        catch: (error) => error,
      });
      return createHash("sha256").update(contents).digest("hex");
    });
  }
  private assertDistinctCredentialsEffect(
    peers: ReadonlyArray<PeerConfig>,
    id: string,
    bearer: string,
    keyFingerprint: string,
  ) {
    return Effect.gen({ self: this }, function* () {
      for (const peer of peers) {
        if (peer.id === id) continue;
        if (sameBearerHash(hashBearer(peer.remoteBearer), hashBearer(bearer)))
          throw new Error("Each Peer must use a distinct remote bearer");
        if ((yield* this.validateKeyEffect(peer.keyPath)) === keyFingerprint)
          throw new Error("Each Peer must use a distinct Tailcat key");
      }
    });
  }
  private writeJsonEffect(value: unknown) {
    return writePrivateJsonEffect(this.paths.configPath, value);
  }
  private withLockEffect<A>(operation: Effect.Effect<A, unknown>): Effect.Effect<A, unknown> {
    return withPrivateLock(this.paths.configPath, operation);
  }
  private privateOperation<A>(operation: () => Promise<A>) {
    return Effect.tryPromise({ try: operation, catch: (error) => error });
  }
}
