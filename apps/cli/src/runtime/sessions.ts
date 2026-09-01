import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writePrivateJson } from "../private-files";

const runtimeSessionSchema = z.object({
  id: z.string().uuid(),
  clientId: z.string().min(1),
  workspaceId: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type RuntimeSession = z.infer<typeof runtimeSessionSchema>;

export class RuntimeSessionStore {
  private readonly directory: string;
  private readonly pending = new Map<string, Promise<RuntimeSession>>();

  constructor(stateRoot: string) {
    this.directory = join(stateRoot, "runtime-sessions");
  }

  getOrCreate(clientId: string, workspaceId: string): Promise<RuntimeSession> {
    const key = runtimeBindingKey(clientId, workspaceId);
    const active = this.pending.get(key);
    if (active) return active;
    const operation = this.loadOrCreate(key, clientId, workspaceId).finally(() =>
      this.pending.delete(key),
    );
    this.pending.set(key, operation);
    return operation;
  }

  async touch(session: RuntimeSession): Promise<void> {
    const path = this.path(runtimeBindingKey(session.clientId, session.workspaceId));
    const current = runtimeSessionSchema.parse(JSON.parse(await readFile(path, "utf8")));
    if (current.id !== session.id) throw new Error("Runtime Session binding changed before touch");
    await writePrivateJson(path, { ...session, updatedAt: new Date().toISOString() });
  }

  async matching(predicate: (session: RuntimeSession) => boolean): Promise<RuntimeSession[]> {
    return (await this.list()).filter(predicate);
  }

  async remove(session: RuntimeSession): Promise<void> {
    await rm(this.path(runtimeBindingKey(session.clientId, session.workspaceId)), { force: true });
  }

  async list(): Promise<RuntimeSession[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map(async (name) =>
          runtimeSessionSchema.parse(
            JSON.parse(await readFile(join(this.directory, name), "utf8")),
          ),
        ),
    );
  }

  private async loadOrCreate(
    key: string,
    clientId: string,
    workspaceId: string,
  ): Promise<RuntimeSession> {
    try {
      return runtimeSessionSchema.parse(JSON.parse(await readFile(this.path(key), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const now = new Date().toISOString();
    const session = runtimeSessionSchema.parse({
      id: randomUUID(),
      clientId,
      workspaceId,
      createdAt: now,
      updatedAt: now,
    });
    await writePrivateJson(this.path(key), session);
    return session;
  }

  private path(key: string): string {
    return join(this.directory, `${key}.json`);
  }
}

function runtimeBindingKey(clientId: string, workspaceId: string): string {
  return createHash("sha256").update(clientId).update("\0").update(workspaceId).digest("hex");
}
