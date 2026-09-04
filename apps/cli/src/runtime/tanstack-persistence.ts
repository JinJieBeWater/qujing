import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ModelMessage, RunRecord } from "@tanstack/ai";
import { defineAIPersistence, defineMessageStore, defineRunStore } from "@tanstack/ai-persistence";
import { defineSandboxInstanceStore, type SandboxInstanceRecord } from "@tanstack/ai-sandbox";
import { Effect } from "effect";
import { writePrivateJsonEffect } from "../private-files";

interface StoreOptions {
  stateRoot: string;
}

type Parser<T> = (input: unknown) => T;

export function createTanStackPersistence(options: StoreOptions) {
  const messages = new JsonStore<Array<ModelMessage>>(
    join(options.stateRoot, "tanstack", "messages"),
  );
  const runs = new JsonStore<RunRecord>(join(options.stateRoot, "tanstack", "runs"));

  return defineAIPersistence({
    stores: {
      messages: defineMessageStore({
        loadThread: (threadId) =>
          Effect.runPromise(messages.getEffect(threadId).pipe(Effect.map((value) => value ?? []))),
        saveThread: (threadId, threadMessages) =>
          Effect.runPromise(messages.setEffect(threadId, threadMessages)),
      }),
      runs: defineRunStore({
        async createOrResume(input) {
          const existing = await Effect.runPromise(runs.getEffect(input.runId));
          if (existing) return existing;
          const record: RunRecord = {
            runId: input.runId,
            threadId: input.threadId,
            status: input.status ?? "running",
            startedAt: input.startedAt,
          };
          await Effect.runPromise(runs.setEffect(input.runId, record));
          return record;
        },
        async update(runId, patch) {
          const existing = await Effect.runPromise(runs.getEffect(runId));
          if (!existing) return;
          await Effect.runPromise(runs.setEffect(runId, { ...existing, ...patch }));
        },
        get: (runId) => Effect.runPromise(runs.getEffect(runId)),
        async listByThread(threadId) {
          return (await Effect.runPromise(runs.listEffect()))
            .filter((run) => run.threadId === threadId)
            .sort(byStartedAt);
        },
        async listReclaimable({ now, ttlMs }) {
          const cutoff = now - ttlMs;
          return (await Effect.runPromise(runs.listEffect())).filter(
            (run) =>
              run.status === "running" &&
              run.detachedSince !== undefined &&
              run.detachedSince <= cutoff,
          );
        },
        async findActiveRun(threadId) {
          let active: RunRecord | null = null;
          for (const run of await Effect.runPromise(runs.listEffect())) {
            if (run.threadId !== threadId || run.status !== "running") continue;
            if (!active || run.startedAt > active.startedAt) active = run;
          }
          return active;
        },
      }),
    },
  });
}

export function createTanStackInstanceStore(options: StoreOptions) {
  const instances = new JsonStore<SandboxInstanceRecord>(
    join(options.stateRoot, "tanstack", "instances"),
  );
  return defineSandboxInstanceStore({
    get: (key) => Effect.runPromise(instances.getEffect(key)),
    upsert: (record) => Effect.runPromise(instances.setEffect(record.key, record)),
    delete: (key) => Effect.runPromise(instances.deleteEffect(key)),
  });
}

export class JsonStore<T> {
  constructor(
    private readonly directory: string,
    private readonly parse?: Parser<T>,
  ) {}

  getEffect(id: string): Effect.Effect<T | null, unknown> {
    return Effect.tryPromise({
      try: () => readFile(this.path(id), "utf8"),
      catch: (error) => error,
    }).pipe(
      Effect.flatMap((text) =>
        Effect.try({
          try: () => {
            const value = JSON.parse(text) as unknown;
            return this.parse ? this.parse(value) : (value as T);
          },
          catch: (error) => error,
        }),
      ),
      Effect.catchIf(
        (error) => (error as NodeJS.ErrnoException).code === "ENOENT",
        () => Effect.succeed(null),
      ),
    );
  }

  setEffect(id: string, value: T): Effect.Effect<void, unknown> {
    return writePrivateJsonEffect(this.path(id), value);
  }

  deleteEffect(id: string): Effect.Effect<void, unknown> {
    return Effect.tryPromise({
      try: () => rm(this.path(id), { force: true }),
      catch: (error) => error,
    });
  }

  listEffect(): Effect.Effect<T[], unknown> {
    return Effect.tryPromise({ try: () => readdir(this.directory), catch: (error) => error }).pipe(
      Effect.catchIf(
        (error) => (error as NodeJS.ErrnoException).code === "ENOENT",
        () => Effect.succeed([]),
      ),
      Effect.flatMap((names) =>
        Effect.all(
          names
            .filter((name) => name.endsWith(".json"))
            .map((name) => this.getEffect(decodeURIComponent(name.slice(0, -5)))),
          { concurrency: "unbounded" },
        ),
      ),
      Effect.map((values) => values.filter((value): value is T => value !== null)),
    );
  }

  private path(id: string): string {
    return join(this.directory, `${encodeURIComponent(id)}.json`);
  }
}

function byStartedAt(left: RunRecord, right: RunRecord): number {
  return left.startedAt - right.startedAt;
}
