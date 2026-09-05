import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { createBearer, hashBearer, sameBearerHash } from "./credentials";
import {
  ensurePrivateDirectoryEffect,
  withPrivateLock,
  writePrivateJsonEffect,
} from "./private-files";
import {
  decode,
  PeerCredential as PeerCredentialSchema,
  HostConfig as HostConfigSchema,
  Identifier,
  NonEmptyString,
  RuntimeConfig as RuntimeConfigSchema,
  Tombstones as TombstonesSchema,
  Workspace as WorkspaceSchema,
  type PeerCredentialIdentity,
  type HostConfig,
  type Node,
  type RuntimeConfig,
  type Workspace,
} from "./schemas";

const parseConfig = decode(HostConfigSchema);
const parseWorkspace = decode(WorkspaceSchema);
const parsePeerCredential = decode(PeerCredentialSchema);
const parseTombstones = decode(TombstonesSchema);
const parseRuntimeConfig = decode(RuntimeConfigSchema);
const parseIdentifier = decode(Identifier);
const parseNonEmptyString = decode(NonEmptyString);

export type Config = HostConfig;
export type WorkspaceConfig = Workspace;

export interface ConfigStorePaths {
  configPath: string;
  stateRoot: string;
}

export interface InitInput {
  node: Node;
  port?: number;
}

export interface WorkspaceInput {
  id: string;
  name: string;
  summary: string;
  root: string;
}

export interface AgentInput {
  id: string;
  tailcatKey: string;
}

export type RuntimeInput = RuntimeConfig;

const DEFAULT_PORT = 43_110;

export class ConfigStore {
  readonly configPath: string;
  readonly stateRoot: string;
  readonly tombstonesPath: string;

  constructor(paths: ConfigStorePaths) {
    this.configPath = paths.configPath;
    this.stateRoot = paths.stateRoot;
    this.tombstonesPath = join(paths.stateRoot, "tombstones.json");
  }

  initEffect(input: InitInput) {
    return Effect.gen({ self: this }, function* () {
      const config = yield* Effect.sync(() =>
        parseConfig({
          version: 1,
          node: input.node,
          server: { host: "127.0.0.1", port: input.port ?? DEFAULT_PORT },
          workspaces: [],
          peers: [],
        }),
      );
      yield* Effect.all(
        [
          ensurePrivateDirectoryEffect(this.stateRoot),
          ensurePrivateDirectoryEffect(dirname(this.configPath)),
        ],
        { concurrency: "unbounded" },
      );
      yield* this.withLockEffect(
        Effect.gen({ self: this }, function* () {
          yield* this.readEffect().pipe(
            Effect.matchEffect({
              onFailure: (error) => {
                if (!(error instanceof Error) || !error.message.includes("Config file not found"))
                  return Effect.fail(error);
                return Effect.gen({ self: this }, function* () {
                  yield* this.writeJsonEffect(this.tombstonesPath, { workspaces: [], peers: [] });
                  yield* this.writeJsonEffect(this.configPath, config);
                });
              },
              onSuccess: (current) => {
                if (JSON.stringify(current) !== JSON.stringify(config))
                  return Effect.fail(
                    new Error("Qujing is already initialized with different configuration"),
                  );
                return this.readTombstonesEffect();
              },
            }),
          );
        }),
      );
    });
  }

  readEffect() {
    return this.privateOperation(() => readFile(this.configPath, "utf8")).pipe(
      Effect.flatMap((text) =>
        Effect.try({ try: () => parseConfig(JSON.parse(text)), catch: (error) => error }),
      ),
      Effect.catchIf(
        (error) => (error as NodeJS.ErrnoException).code === "ENOENT",
        () => Effect.fail(new Error(`Config file not found: ${this.configPath}`)),
      ),
    );
  }

  readEffectiveEffect() {
    return Effect.gen({ self: this }, function* () {
      const [config, tombstones] = yield* Effect.all(
        [this.readEffect(), this.readTombstonesEffect()],
        { concurrency: "unbounded" },
      );
      return {
        ...config,
        workspaces: config.workspaces.filter(({ id }) => !tombstones.workspaces.includes(id)),
        peers: config.peers.filter(({ id }) => !tombstones.peers.includes(id)),
      };
    });
  }

  addWorkspaceEffect(input: WorkspaceInput) {
    return Effect.gen({ self: this }, function* () {
      const root = yield* this.privateOperation(() => realpath(input.root)).pipe(
        Effect.mapError(() => new Error(`Workspace root does not exist: ${input.root}`)),
      );
      const info = yield* this.privateOperation(() => stat(root));
      if (!info.isDirectory()) throw new Error(`Workspace root is not a directory: ${input.root}`);
      const workspace = yield* Effect.sync(() => parseWorkspace({ ...input, root }));
      yield* this.withLockEffect(
        Effect.gen({ self: this }, function* () {
          const [config, tombstones] = yield* Effect.all([
            this.readEffect(),
            this.readTombstonesEffect(),
          ]);
          if (tombstones.workspaces.includes(workspace.id))
            throw new Error("Workspace ID was removed and cannot be reused");
          const existing = config.workspaces.find(({ id }) => id === workspace.id);
          if (existing) {
            if (JSON.stringify(existing) === JSON.stringify(workspace)) return;
            throw new Error("Workspace ID already exists with different configuration");
          }
          if (config.workspaces.some(({ root }) => root === workspace.root))
            throw new Error("Workspace root is already registered");
          yield* this.writeJsonEffect(
            this.configPath,
            parseConfig({ ...config, workspaces: [...config.workspaces, workspace] }),
          );
        }),
      );
    });
  }

  updateWorkspaceEffect(id: string, update: { name?: string; summary?: string }) {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.sync(() => parseIdentifier(id));
      yield* this.withLockEffect(
        Effect.gen({ self: this }, function* () {
          const [config, tombstones] = yield* Effect.all([
            this.readEffect(),
            this.readTombstonesEffect(),
          ]);
          if (tombstones.workspaces.includes(id)) throw new Error(`Workspace not found: ${id}`);
          const workspace = config.workspaces.find((entry) => entry.id === id);
          if (!workspace) throw new Error(`Workspace not found: ${id}`);
          const next = {
            ...workspace,
            ...(update.name === undefined ? {} : { name: parseNonEmptyString(update.name) }),
            ...(update.summary === undefined
              ? {}
              : { summary: parseNonEmptyString(update.summary) }),
          };
          yield* this.writeJsonEffect(
            this.configPath,
            parseConfig({
              ...config,
              workspaces: config.workspaces.map((entry) => (entry.id === id ? next : entry)),
            }),
          );
        }),
      );
    });
  }

  removeWorkspaceEffect(id: string) {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.sync(() => parseIdentifier(id));
      return yield* this.withLockEffect(
        Effect.gen({ self: this }, function* () {
          const config = yield* this.readEffect();
          const workspaces = config.workspaces.filter((entry) => entry.id !== id);
          if (workspaces.length === config.workspaces.length) return false;
          const tombstones = yield* this.readTombstonesEffect();
          yield* this.writeJsonEffect(
            this.tombstonesPath,
            parseTombstones({
              ...tombstones,
              workspaces: tombstones.workspaces.includes(id)
                ? tombstones.workspaces
                : [...tombstones.workspaces, id],
            }),
          );
          yield* this.writeJsonEffect(this.configPath, parseConfig({ ...config, workspaces }));
          return true;
        }),
      );
    });
  }

  addAgentEffect(input: AgentInput, bearer = createBearer()) {
    return Effect.gen({ self: this }, function* () {
      const parsed = yield* Effect.sync(() => ({
        id: parseIdentifier(input.id),
        tailcatKey: parseNonEmptyString(input.tailcatKey),
        bearer: parseNonEmptyString(bearer),
      }));
      return yield* this.withLockEffect(
        Effect.gen({ self: this }, function* () {
          const [config, tombstones] = yield* Effect.all([
            this.readEffect(),
            this.readTombstonesEffect(),
          ]);
          if (tombstones.peers.includes(parsed.id))
            throw new Error("Peer credential ID was revoked and cannot be reused");
          if (config.peers.some(({ id }) => id === parsed.id))
            throw new Error(`Peer credential already exists: ${parsed.id}`);
          const now = new Date().toISOString();
          const agent = parsePeerCredential({
            id: parsed.id,
            tailcatKey: parsed.tailcatKey,
            bearerHash: hashBearer(parsed.bearer),
            createdAt: now,
            updatedAt: now,
          });
          yield* this.writeJsonEffect(
            this.configPath,
            parseConfig({ ...config, peers: [...config.peers, agent] }),
          );
          return { bearer: parsed.bearer };
        }),
      );
    });
  }

  rotateAgentEffect(id: string, tailcatKey: string) {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.sync(() => {
        parseIdentifier(id);
        parseNonEmptyString(tailcatKey);
      });
      return yield* this.withLockEffect(
        Effect.gen({ self: this }, function* () {
          const [config, tombstones] = yield* Effect.all([
            this.readEffect(),
            this.readTombstonesEffect(),
          ]);
          if (tombstones.peers.includes(id)) throw new Error(`Peer credential not found: ${id}`);
          if (!config.peers.some((entry) => entry.id === id))
            throw new Error(`Peer credential not found: ${id}`);
          const bearer = createBearer();
          yield* this.writeJsonEffect(
            this.configPath,
            parseConfig({
              ...config,
              peers: config.peers.map((entry) =>
                entry.id === id
                  ? {
                      ...entry,
                      tailcatKey,
                      bearerHash: hashBearer(bearer),
                      updatedAt: new Date().toISOString(),
                    }
                  : entry,
              ),
            }),
          );
          return { bearer };
        }),
      );
    });
  }

  revokeAgentEffect(id: string) {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.sync(() => parseIdentifier(id));
      return yield* this.withLockEffect(
        Effect.gen({ self: this }, function* () {
          const config = yield* this.readEffect();
          const peers = config.peers.filter((entry) => entry.id !== id);
          if (peers.length === config.peers.length) return false;
          const tombstones = yield* this.readTombstonesEffect();
          yield* this.writeJsonEffect(
            this.tombstonesPath,
            parseTombstones({
              ...tombstones,
              peers: tombstones.peers.includes(id) ? tombstones.peers : [...tombstones.peers, id],
            }),
          );
          yield* this.writeJsonEffect(this.configPath, parseConfig({ ...config, peers }));
          return true;
        }),
      );
    });
  }

  setRuntimeEffect(input: RuntimeInput) {
    return Effect.gen({ self: this }, function* () {
      const runtime = yield* Effect.sync(() => parseRuntimeConfig(input));
      yield* this.withLockEffect(
        Effect.gen({ self: this }, function* () {
          const config = yield* this.readEffect();
          yield* this.writeJsonEffect(this.configPath, parseConfig({ ...config, runtime }));
        }),
      );
    });
  }

  authenticateEffect(bearer: string) {
    return Effect.gen({ self: this }, function* () {
      const hash = hashBearer(bearer);
      const [config, tombstones] = yield* Effect.all(
        [this.readEffect(), this.readTombstonesEffect()],
        { concurrency: "unbounded" },
      );
      const agent = config.peers.find(
        (entry) => !tombstones.peers.includes(entry.id) && sameBearerHash(entry.bearerHash, hash),
      );
      return agent ? { id: agent.id, credentialVersion: agent.bearerHash } : undefined;
    });
  }

  getWorkspaceEffect(id: string) {
    return Effect.gen({ self: this }, function* () {
      const [config, tombstones] = yield* Effect.all(
        [this.readEffect(), this.readTombstonesEffect()],
        { concurrency: "unbounded" },
      );
      return tombstones.workspaces.includes(id)
        ? undefined
        : config.workspaces.find((workspace) => workspace.id === id);
    });
  }

  hasAgentEffect(agent: PeerCredentialIdentity) {
    return Effect.gen({ self: this }, function* () {
      const [config, tombstones] = yield* Effect.all(
        [this.readEffect(), this.readTombstonesEffect()],
        { concurrency: "unbounded" },
      );
      return (
        !tombstones.peers.includes(agent.id) &&
        config.peers.some(
          (entry) => entry.id === agent.id && entry.bearerHash === agent.credentialVersion,
        )
      );
    });
  }

  withLockEffect<A>(operation: Effect.Effect<A, unknown>): Effect.Effect<A, unknown> {
    return withPrivateLock(this.configPath, operation);
  }

  listPublicWorkspacesEffect() {
    return Effect.gen({ self: this }, function* () {
      const [config, tombstones] = yield* Effect.all(
        [this.readEffect(), this.readTombstonesEffect()],
        { concurrency: "unbounded" },
      );
      return yield* Effect.all(
        config.workspaces
          .filter(({ id }) => !tombstones.workspaces.includes(id))
          .map(({ id, name, summary, root }) =>
            this.isWorkspaceAvailableEffect(root).pipe(
              Effect.map((available) => ({ id, name, summary, available })),
            ),
          ),
        { concurrency: "unbounded" },
      );
    });
  }

  isWorkspaceAvailableEffect(root: string) {
    return Effect.all([
      this.privateOperation(() => access(root, constants.R_OK)),
      this.privateOperation(() => realpath(root)),
      this.privateOperation(() => stat(root)),
    ]).pipe(
      Effect.map(([, canonicalRoot, info]) => canonicalRoot === root && info.isDirectory()),
      Effect.catch(() => Effect.succeed(false)),
    );
  }

  private readTombstonesEffect() {
    return this.privateOperation(() => readFile(this.tombstonesPath, "utf8")).pipe(
      Effect.flatMap((text) =>
        Effect.try({ try: () => parseTombstones(JSON.parse(text)), catch: (error) => error }),
      ),
      Effect.catchIf(
        (error) => (error as NodeJS.ErrnoException).code === "ENOENT",
        () => Effect.fail(new Error(`Security state file not found: ${this.tombstonesPath}`)),
      ),
    );
  }

  private writeJsonEffect(path: string, value: unknown) {
    return writePrivateJsonEffect(path, value);
  }

  private privateOperation<A>(operation: () => Promise<A>) {
    return Effect.tryPromise({ try: operation, catch: (error) => error });
  }
}
