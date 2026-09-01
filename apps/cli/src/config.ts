import { access, readFile, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { ensurePrivateDirectory, withFileLock, writePrivateJson } from "./private-files";
import { createBearer, hashBearer, sameBearerHash } from "./credentials";
import type { ClientIdentity, OwnerMetadata, PublicWorkspace } from "./types";

const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const ownerSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  summary: z.string().min(1).optional(),
});
const workspaceSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  summary: z.string().min(1),
  root: z.string().refine(isAbsolute, "Workspace root must be absolute"),
});
const clientSchema = z.object({
  id: idSchema,
  tailcatKey: z.string().min(1),
  bearerHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
const configSchema = z.object({
  version: z.literal(1),
  owner: ownerSchema,
  server: z.object({ host: z.literal("127.0.0.1"), port: z.number().int().min(1).max(65_535) }),
  workspaces: z.array(workspaceSchema),
  clients: z.array(clientSchema),
});
const tombstonesSchema = z.object({
  workspaces: z.array(idSchema),
  clients: z.array(idSchema),
});

export type Config = z.infer<typeof configSchema>;
export type WorkspaceConfig = z.infer<typeof workspaceSchema>;
export interface ConfigStorePaths {
  configPath: string;
  stateRoot: string;
}

export interface InitInput {
  owner: OwnerMetadata;
  port?: number;
}

export interface WorkspaceInput {
  id: string;
  name: string;
  summary: string;
  root: string;
}

export interface ClientInput {
  id: string;
  tailcatKey: string;
}

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

  async init(input: InitInput): Promise<void> {
    const config = configSchema.parse({
      version: 1,
      owner: input.owner,
      server: { host: "127.0.0.1", port: input.port ?? DEFAULT_PORT },
      workspaces: [],
      clients: [],
    });
    await ensurePrivateDirectory(this.stateRoot);
    await ensurePrivateDirectory(dirname(this.configPath));
    await withFileLock(this.configPath, async () => {
      try {
        const current = await this.read();
        if (JSON.stringify(current) === JSON.stringify(config)) {
          await this.readTombstones();
          return;
        }
        throw new Error("Colleague Line is already initialized with different configuration");
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("Config file not found"))
          throw error;
      }
      await writePrivateJson(this.tombstonesPath, { workspaces: [], clients: [] });
      await writePrivateJson(this.configPath, config);
    });
  }

  async read(): Promise<Config> {
    try {
      return configSchema.parse(JSON.parse(await readFile(this.configPath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new Error(`Config file not found: ${this.configPath}`);
      throw error;
    }
  }

  async readEffective(): Promise<Config> {
    const [config, tombstones] = await Promise.all([this.read(), this.readTombstones()]);
    return {
      ...config,
      workspaces: config.workspaces.filter(
        (workspace) => !tombstones.workspaces.includes(workspace.id),
      ),
      clients: config.clients.filter((client) => !tombstones.clients.includes(client.id)),
    };
  }

  async addWorkspace(input: WorkspaceInput): Promise<void> {
    const root = await realpath(input.root).catch(() => {
      throw new Error(`Workspace root does not exist: ${input.root}`);
    });
    if (!(await stat(root)).isDirectory())
      throw new Error(`Workspace root is not a directory: ${input.root}`);
    const workspace = workspaceSchema.parse({ ...input, root });
    await withFileLock(this.configPath, async () => {
      const config = await this.read();
      const tombstones = await this.readTombstones();
      if (tombstones.workspaces.includes(workspace.id))
        throw new Error("Workspace ID was removed and cannot be reused");
      const existing = config.workspaces.find((entry) => entry.id === workspace.id);
      if (existing) {
        if (JSON.stringify(existing) === JSON.stringify(workspace)) return;
        throw new Error("Workspace ID already exists with different configuration");
      }
      if (config.workspaces.some((entry) => entry.root === workspace.root)) {
        throw new Error("Workspace root is already registered");
      }
      config.workspaces.push(workspace);
      await writePrivateJson(this.configPath, config);
    });
  }

  async updateWorkspace(id: string, update: { name?: string; summary?: string }): Promise<void> {
    idSchema.parse(id);
    await withFileLock(this.configPath, async () => {
      const config = await this.read();
      const tombstones = await this.readTombstones();
      if (tombstones.workspaces.includes(id)) throw new Error(`Workspace not found: ${id}`);
      const workspace = config.workspaces.find((entry) => entry.id === id);
      if (!workspace) throw new Error(`Workspace not found: ${id}`);
      if (update.name !== undefined) workspace.name = z.string().min(1).parse(update.name);
      if (update.summary !== undefined) workspace.summary = z.string().min(1).parse(update.summary);
      await writePrivateJson(this.configPath, configSchema.parse(config));
    });
  }

  async removeWorkspace(id: string): Promise<boolean> {
    idSchema.parse(id);
    return withFileLock(this.configPath, async () => {
      const config = await this.read();
      const next = config.workspaces.filter((entry) => entry.id !== id);
      if (next.length === config.workspaces.length) return false;
      config.workspaces = next;
      const tombstones = await this.readTombstones();
      if (!tombstones.workspaces.includes(id)) tombstones.workspaces.push(id);
      await writePrivateJson(this.tombstonesPath, tombstones);
      await writePrivateJson(this.configPath, config);
      return true;
    });
  }

  async addClient(input: ClientInput): Promise<{ bearer: string }> {
    const parsed = z.object({ id: idSchema, tailcatKey: z.string().min(1) }).parse(input);
    return withFileLock(this.configPath, async () => {
      const config = await this.read();
      const tombstones = await this.readTombstones();
      if (tombstones.clients.includes(parsed.id))
        throw new Error("Client ID was revoked and cannot be reused");
      if (config.clients.some((client) => client.id === parsed.id))
        throw new Error(`Client already exists: ${parsed.id}`);
      const bearer = createBearer();
      const now = new Date().toISOString();
      config.clients.push({
        ...parsed,
        bearerHash: hashBearer(bearer),
        createdAt: now,
        updatedAt: now,
      });
      await writePrivateJson(this.configPath, configSchema.parse(config));
      return { bearer };
    });
  }

  async rotateClient(id: string, tailcatKey: string): Promise<{ bearer: string }> {
    idSchema.parse(id);
    z.string().min(1).parse(tailcatKey);
    return withFileLock(this.configPath, async () => {
      const config = await this.read();
      const tombstones = await this.readTombstones();
      if (tombstones.clients.includes(id)) throw new Error(`Client not found: ${id}`);
      const client = config.clients.find((entry) => entry.id === id);
      if (!client) throw new Error(`Client not found: ${id}`);
      const bearer = createBearer();
      client.tailcatKey = tailcatKey;
      client.bearerHash = hashBearer(bearer);
      client.updatedAt = new Date().toISOString();
      await writePrivateJson(this.configPath, configSchema.parse(config));
      return { bearer };
    });
  }

  async revokeClient(id: string): Promise<boolean> {
    idSchema.parse(id);
    return withFileLock(this.configPath, async () => {
      const config = await this.read();
      const next = config.clients.filter((entry) => entry.id !== id);
      if (next.length === config.clients.length) return false;
      config.clients = next;
      const tombstones = await this.readTombstones();
      if (!tombstones.clients.includes(id)) tombstones.clients.push(id);
      await writePrivateJson(this.tombstonesPath, tombstones);
      await writePrivateJson(this.configPath, config);
      return true;
    });
  }

  async authenticate(bearer: string): Promise<ClientIdentity | undefined> {
    const hash = hashBearer(bearer);
    const [config, tombstones] = await Promise.all([this.read(), this.readTombstones()]);
    const client = config.clients.find(
      (entry) => !tombstones.clients.includes(entry.id) && sameBearerHash(entry.bearerHash, hash),
    );
    return client ? { id: client.id, credentialVersion: client.bearerHash } : undefined;
  }

  async getWorkspace(id: string): Promise<WorkspaceConfig | undefined> {
    const [config, tombstones] = await Promise.all([this.read(), this.readTombstones()]);
    if (tombstones.workspaces.includes(id)) return undefined;
    return config.workspaces.find((workspace) => workspace.id === id);
  }

  async hasClient(client: ClientIdentity): Promise<boolean> {
    const [config, tombstones] = await Promise.all([this.read(), this.readTombstones()]);
    return (
      !tombstones.clients.includes(client.id) &&
      config.clients.some(
        (entry) => entry.id === client.id && entry.bearerHash === client.credentialVersion,
      )
    );
  }

  withLock<T>(operation: () => Promise<T>): Promise<T> {
    return withFileLock(this.configPath, operation);
  }

  async listPublicWorkspaces(): Promise<PublicWorkspace[]> {
    const [config, tombstones] = await Promise.all([this.read(), this.readTombstones()]);
    return Promise.all(
      config.workspaces
        .filter(({ id }) => !tombstones.workspaces.includes(id))
        .map(async ({ id, name, summary, root }) => ({
          id,
          name,
          summary,
          available: await this.isWorkspaceAvailable(root),
        })),
    );
  }

  async isWorkspaceAvailable(root: string): Promise<boolean> {
    try {
      await access(root, constants.R_OK);
      return (await realpath(root)) === root && (await stat(root)).isDirectory();
    } catch {
      return false;
    }
  }

  private async readTombstones(): Promise<z.infer<typeof tombstonesSchema>> {
    try {
      return tombstonesSchema.parse(JSON.parse(await readFile(this.tombstonesPath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new Error(`Security state file not found: ${this.tombstonesPath}`);
      throw error;
    }
  }
}
