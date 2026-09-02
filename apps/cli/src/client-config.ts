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
  ClientConfig as ClientConfigSchema,
  decode,
  Identifier,
  Line as LineSchema,
  LineCredentials as LineCredentialsSchema,
  LineInput as LineInputSchema,
  type ClientConfig as ClientConfigData,
  type Line as LineData,
  type LineInput as LineInputData,
} from "./schemas";

const parseConfig = decode(ClientConfigSchema);
const parseIdentifier = decode(Identifier);
const parseLine = decode(LineSchema);
const parseLineInput = decode(LineInputSchema);
const parseLineCredentials = decode(LineCredentialsSchema);

export type ClientConfig = ClientConfigData;
export type LineConfig = LineData;
export type LineInput = LineInputData;
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
                  lines: [],
                }),
              ).pipe(Effect.as({ initialized: true as const, bearer }));
            },
            onSuccess: (current) =>
              input.port !== undefined && current.server.port !== input.port
                ? Effect.fail(new Error("Client is already initialized with a different port"))
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
        ? { id: LOCAL_CLIENT_ID, credentialVersion: config.localBearerHash }
        : undefined;
    });
  }

  validateEffect(input: LineInput) {
    return this.validateLineEffect(input).pipe(Effect.map(({ line }) => line));
  }

  addEffect(input: LineInput) {
    return Effect.gen({ self: this }, function* () {
      const { line, fingerprint } = yield* this.validateLineEffect(input);
      yield* this.withLockEffect(
        Effect.gen({ self: this }, function* () {
          const config = yield* this.readEffect();
          const existing = config.lines.find(({ id }) => id === line.id);
          if (existing) {
            const { createdAt: _createdAt, updatedAt: _updatedAt, ...comparable } = existing;
            if (JSON.stringify(comparable) === JSON.stringify(line)) return;
            throw new Error(`Line already exists with different configuration: ${line.id}`);
          }
          yield* this.assertDistinctCredentialsEffect(
            config.lines,
            line.id,
            line.remoteBearer,
            fingerprint,
          );
          const now = new Date().toISOString();
          yield* this.writeJsonEffect(
            parseConfig({
              ...config,
              lines: [...config.lines, parseLine({ ...line, createdAt: now, updatedAt: now })],
            }),
          );
        }),
      );
    });
  }

  listEffect() {
    return this.readEffect().pipe(
      Effect.map((config) =>
        config.lines.map(
          ({ id, expectedOwnerId, remoteClientId, remotePort, createdAt, updatedAt }) => ({
            id,
            expectedOwnerId,
            remoteClientId,
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
      return (yield* this.readEffect()).lines.find((line) => line.id === id);
    });
  }

  validateCredentialsEffect(input: Pick<LineConfig, "keyPath" | "remoteBearer">) {
    return this.validateCredentialInputEffect(input).pipe(
      Effect.map(({ credentials }) => credentials),
    );
  }

  updateCredentialsEffect(id: string, update: Pick<LineConfig, "keyPath" | "remoteBearer">) {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.sync(() => parseIdentifier(id));
      const { credentials, fingerprint } = yield* this.validateCredentialInputEffect(update);
      yield* this.withLockEffect(
        Effect.gen({ self: this }, function* () {
          const config = yield* this.readEffect();
          if (!config.lines.some((entry) => entry.id === id))
            throw new Error(`Line not found: ${id}`);
          yield* this.assertDistinctCredentialsEffect(
            config.lines,
            id,
            credentials.remoteBearer,
            fingerprint,
          );
          yield* this.writeJsonEffect(
            parseConfig({
              ...config,
              lines: config.lines.map((line) =>
                line.id === id
                  ? { ...line, ...credentials, updatedAt: new Date().toISOString() }
                  : line,
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
          const lines = config.lines.filter((line) => line.id !== id);
          if (lines.length === config.lines.length) return false;
          yield* this.writeJsonEffect(parseConfig({ ...config, lines }));
          return true;
        }),
      );
    });
  }

  private validateLineEffect(input: LineInput) {
    return Effect.gen({ self: this }, function* () {
      const line = yield* Effect.sync(() => parseLineInput(input));
      return { line, fingerprint: yield* this.validateKeyEffect(line.keyPath) };
    });
  }
  private validateCredentialInputEffect(input: Pick<LineConfig, "keyPath" | "remoteBearer">) {
    return Effect.gen({ self: this }, function* () {
      const credentials = yield* Effect.sync(() => parseLineCredentials(input));
      return { credentials, fingerprint: yield* this.validateKeyEffect(credentials.keyPath) };
    });
  }
  private validateKeyEffect(path: string) {
    return Effect.gen(function* () {
      const key = yield* Effect.tryPromise({
        try: () => stat(path),
        catch: () => new Error(`Line key not found: ${path}`),
      });
      if (!key.isFile()) throw new Error(`Line key is not a file: ${path}`);
      yield* assertPrivatePathEffect(path, false).pipe(
        Effect.mapError(() => new Error(`Line key permissions must be 0600: ${path}`)),
      );
      const contents = yield* Effect.tryPromise({
        try: () => readFile(path),
        catch: (error) => error,
      });
      return createHash("sha256").update(contents).digest("hex");
    });
  }
  private assertDistinctCredentialsEffect(
    lines: ReadonlyArray<LineConfig>,
    id: string,
    bearer: string,
    keyFingerprint: string,
  ) {
    return Effect.gen({ self: this }, function* () {
      for (const line of lines) {
        if (line.id === id) continue;
        if (sameBearerHash(hashBearer(line.remoteBearer), hashBearer(bearer)))
          throw new Error("Each Line must use a distinct remote bearer");
        if ((yield* this.validateKeyEffect(line.keyPath)) === keyFingerprint)
          throw new Error("Each Line must use a distinct Tailcat key");
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
