import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod";
import { createBearer, hashBearer, sameBearerHash } from "./credentials";
import {
  assertPrivatePath,
  ensurePrivateDirectory,
  withFileLock,
  writePrivateJson,
} from "./private-files";
import type { ClientIdentity } from "./types";

const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const keyPathSchema = z.string().max(4_096).refine(isAbsolute, "Line key path must be absolute");
const bearerSchema = z.string().min(1).max(4_096);
const lineSchema = z.object({
  id: idSchema,
  expectedOwnerId: idSchema,
  remoteClientId: idSchema,
  serverAddress: z.string().min(1).max(4_096),
  remotePort: z.number().int().min(1).max(65_535),
  keyPath: keyPathSchema,
  remoteBearer: bearerSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
const configSchema = z.object({
  version: z.literal(1),
  server: z.object({ host: z.literal("127.0.0.1"), port: z.number().int().min(1).max(65_535) }),
  localBearerHash: z.string().regex(/^[a-f0-9]{64}$/),
  lines: z.array(lineSchema).max(64),
});

export type ClientConfig = z.infer<typeof configSchema>;
export type LineConfig = z.infer<typeof lineSchema>;
export type LineInput = Omit<LineConfig, "createdAt" | "updatedAt">;
export type PublicLine = Pick<
  LineConfig,
  "id" | "expectedOwnerId" | "remoteClientId" | "remotePort" | "createdAt" | "updatedAt"
>;
export const LOCAL_CLIENT_ID = "local-agent";

export interface ClientConfigStorePaths {
  configPath: string;
}
export type ClientInitResult =
  | { initialized: true; bearer: string }
  | { initialized: false; alreadyInitialized: true };

export class ClientConfigStore {
  constructor(readonly paths: ClientConfigStorePaths) {}

  async init(input: { port?: number } = {}): Promise<ClientInitResult> {
    await ensurePrivateDirectory(dirname(this.paths.configPath));
    return withFileLock(this.paths.configPath, async () => {
      try {
        const current = await this.read();
        if (input.port !== undefined && current.server.port !== input.port)
          throw new Error("Client is already initialized with a different port");
        return { initialized: false, alreadyInitialized: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const bearer = createBearer();
      await writePrivateJson(
        this.paths.configPath,
        configSchema.parse({
          version: 1,
          server: { host: "127.0.0.1", port: input.port ?? 43_111 },
          localBearerHash: hashBearer(bearer),
          lines: [],
        }),
      );
      return { initialized: true, bearer };
    });
  }

  async read(): Promise<ClientConfig> {
    await assertPrivatePath(dirname(this.paths.configPath), true);
    await assertPrivatePath(this.paths.configPath, false);
    return configSchema.parse(JSON.parse(await readFile(this.paths.configPath, "utf8")));
  }

  async rotateLocalBearer(): Promise<{ bearer: string }> {
    return withFileLock(this.paths.configPath, async () => {
      const config = await this.read();
      const bearer = createBearer();
      config.localBearerHash = hashBearer(bearer);
      await writePrivateJson(this.paths.configPath, config);
      return { bearer };
    });
  }

  async authenticateLocal(bearer: string): Promise<ClientIdentity | undefined> {
    const config = await this.read();
    return sameBearerHash(config.localBearerHash, hashBearer(bearer))
      ? { id: LOCAL_CLIENT_ID, credentialVersion: config.localBearerHash }
      : undefined;
  }

  async validate(input: LineInput): Promise<LineInput> {
    const line = lineSchema.omit({ createdAt: true, updatedAt: true }).parse(input);
    await this.validateKey(line.keyPath);
    return line;
  }

  async add(input: LineInput): Promise<void> {
    const line = await this.validate(input);
    const fingerprint = await this.validateKey(line.keyPath);
    await withFileLock(this.paths.configPath, async () => {
      const config = await this.read();
      const existing = config.lines.find(({ id }) => id === line.id);
      if (existing) {
        const comparable = { ...existing, createdAt: undefined, updatedAt: undefined };
        if (JSON.stringify(comparable) === JSON.stringify(line)) return;
        throw new Error(`Line already exists with different configuration: ${line.id}`);
      }
      await this.assertDistinctCredentials(config.lines, line.id, line.remoteBearer, fingerprint);
      const now = new Date().toISOString();
      config.lines.push({ ...line, createdAt: now, updatedAt: now });
      await writePrivateJson(this.paths.configPath, configSchema.parse(config));
    });
  }

  async list(): Promise<PublicLine[]> {
    return (await this.read()).lines.map(
      ({ id, expectedOwnerId, remoteClientId, remotePort, createdAt, updatedAt }) => ({
        id,
        expectedOwnerId,
        remoteClientId,
        remotePort,
        createdAt,
        updatedAt,
      }),
    );
  }

  async get(id: string): Promise<LineConfig | undefined> {
    idSchema.parse(id);
    return (await this.read()).lines.find((line) => line.id === id);
  }

  async validateCredentials(
    input: Pick<LineConfig, "keyPath" | "remoteBearer">,
  ): Promise<Pick<LineConfig, "keyPath" | "remoteBearer">> {
    const credentials = z
      .object({ keyPath: keyPathSchema, remoteBearer: bearerSchema })
      .parse(input);
    await this.validateKey(credentials.keyPath);
    return credentials;
  }

  async updateCredentials(
    id: string,
    update: Pick<LineConfig, "keyPath" | "remoteBearer">,
  ): Promise<void> {
    idSchema.parse(id);
    const credentials = await this.validateCredentials(update);
    const fingerprint = await this.validateKey(credentials.keyPath);
    await withFileLock(this.paths.configPath, async () => {
      const config = await this.read();
      const line = config.lines.find((entry) => entry.id === id);
      if (!line) throw new Error(`Line not found: ${id}`);
      await this.assertDistinctCredentials(config.lines, id, credentials.remoteBearer, fingerprint);
      line.keyPath = credentials.keyPath;
      line.remoteBearer = credentials.remoteBearer;
      line.updatedAt = new Date().toISOString();
      await writePrivateJson(this.paths.configPath, configSchema.parse(config));
    });
  }

  async remove(id: string): Promise<boolean> {
    idSchema.parse(id);
    return withFileLock(this.paths.configPath, async () => {
      const config = await this.read();
      const lines = config.lines.filter((line) => line.id !== id);
      if (lines.length === config.lines.length) return false;
      config.lines = lines;
      await writePrivateJson(this.paths.configPath, config);
      return true;
    });
  }

  private async validateKey(path: string): Promise<string> {
    const key = await stat(path).catch(() => {
      throw new Error(`Line key not found: ${path}`);
    });
    if (!key.isFile()) throw new Error(`Line key is not a file: ${path}`);
    await assertPrivatePath(path, false).catch(() => {
      throw new Error(`Line key permissions must be 0600: ${path}`);
    });
    return createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  }

  private async assertDistinctCredentials(
    lines: LineConfig[],
    id: string,
    bearer: string,
    keyFingerprint: string,
  ): Promise<void> {
    for (const line of lines) {
      if (line.id === id) continue;
      if (sameBearerHash(hashBearer(line.remoteBearer), hashBearer(bearer)))
        throw new Error("Each Line must use a distinct remote bearer");
      if ((await this.validateKey(line.keyPath)) === keyFingerprint)
        throw new Error("Each Line must use a distinct Tailcat key");
    }
  }
}
