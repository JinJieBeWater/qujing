import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Deferred, Effect, Semaphore } from "effect";
import { writePrivateJsonEffect } from "../private-files";
import {
  decode,
  RuntimeSession as RuntimeSessionSchema,
  type RuntimeSession as RuntimeSessionData,
} from "../schemas";

const parseRuntimeSession = decode(RuntimeSessionSchema);

export type RuntimeSession = RuntimeSessionData;

export class RuntimeSessionStore {
  private readonly directory: string;
  private readonly gate = Semaphore.makeUnsafe(1);
  private readonly pending = new Map<string, Deferred.Deferred<RuntimeSession, unknown>>();

  constructor(stateRoot: string) {
    this.directory = join(stateRoot, "runtime-sessions");
  }

  getOrCreateEffect(clientId: string, workspaceId: string) {
    const key = runtimeBindingKey(clientId, workspaceId);
    return Effect.gen({ self: this }, function* () {
      const decision = yield* this.gate.withPermit(
        Effect.sync(() => {
          const active = this.pending.get(key);
          if (active) return { deferred: active, owner: false } as const;
          const deferred = Deferred.makeUnsafe<RuntimeSession, unknown>();
          this.pending.set(key, deferred);
          return { deferred, owner: true } as const;
        }),
      );
      if (!decision.owner) return yield* Deferred.await(decision.deferred);
      return yield* Effect.uninterruptible(
        this.loadOrCreateEffect(key, clientId, workspaceId).pipe(
          Effect.exit,
          Effect.tap((exit) => Deferred.done(decision.deferred, exit)),
          Effect.ensuring(
            this.gate.withPermit(
              Effect.sync(() => {
                if (this.pending.get(key) === decision.deferred) this.pending.delete(key);
              }),
            ),
          ),
          Effect.flatMap((exit) => exit),
        ),
      );
    });
  }

  touchEffect(session: RuntimeSession) {
    return Effect.gen({ self: this }, function* () {
      const path = this.path(runtimeBindingKey(session.clientId, session.workspaceId));
      const current = yield* this.readSessionEffect(path);
      if (current.id !== session.id)
        throw new Error("Runtime Session binding changed before touch");
      yield* this.writeSessionEffect(path, { ...session, updatedAt: new Date().toISOString() });
    });
  }

  matchingEffect(predicate: (session: RuntimeSession) => boolean) {
    return this.listEffect().pipe(Effect.map((sessions) => sessions.filter(predicate)));
  }

  removeEffect(session: RuntimeSession) {
    return this.operation(() =>
      rm(this.path(runtimeBindingKey(session.clientId, session.workspaceId)), { force: true }),
    );
  }

  listEffect() {
    return Effect.gen({ self: this }, function* () {
      const names = yield* this.operation(() => readdir(this.directory)).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            (error as NodeJS.ErrnoException).code === "ENOENT"
              ? Effect.succeed([])
              : Effect.fail(error),
          onSuccess: Effect.succeed,
        }),
      );
      return yield* Effect.all(
        names
          .filter((name) => name.endsWith(".json"))
          .map((name) => this.readSessionEffect(join(this.directory, name))),
        { concurrency: "unbounded" },
      );
    });
  }

  private loadOrCreateEffect(key: string, clientId: string, workspaceId: string) {
    return Effect.gen({ self: this }, function* () {
      const path = this.path(key);
      const existing = yield* this.readSessionEffect(path).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            (error as NodeJS.ErrnoException).code === "ENOENT"
              ? Effect.succeed(undefined)
              : Effect.fail(error),
          onSuccess: Effect.succeed,
        }),
      );
      if (existing) return existing;
      const now = new Date().toISOString();
      const session = yield* Effect.sync(() =>
        parseRuntimeSession({
          id: randomUUID(),
          clientId,
          workspaceId,
          createdAt: now,
          updatedAt: now,
        }),
      );
      yield* this.writeSessionEffect(path, session);
      return session;
    });
  }

  private readSessionEffect(path: string) {
    return Effect.gen({ self: this }, function* () {
      const text = yield* this.operation(() => readFile(path, "utf8"));
      return yield* Effect.try({
        try: () => parseRuntimeSession(JSON.parse(text)),
        catch: (error) => error,
      });
    });
  }

  private writeSessionEffect(path: string, session: RuntimeSession) {
    return writePrivateJsonEffect(path, session);
  }

  private operation<A>(operation: () => Promise<A>) {
    return Effect.tryPromise({ try: operation, catch: (error) => error });
  }

  private path(key: string): string {
    return join(this.directory, `${key}.json`);
  }
}

function runtimeBindingKey(clientId: string, workspaceId: string): string {
  return createHash("sha256").update(clientId).update("\0").update(workspaceId).digest("hex");
}
