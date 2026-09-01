import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore, type WorkspaceConfig } from "../src/config";
import { RuntimeCoordinator } from "../src/runtime/coordinator";
import { PiRuntime, type ManagedPiSession } from "../src/runtime/pi-runtime";
import { RuntimeSessionStore, type RuntimeSession } from "../src/runtime/sessions";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(
  createSession: (
    workspace: WorkspaceConfig,
    session: RuntimeSession,
  ) => ManagedPiSession | Promise<ManagedPiSession> = () => fakeSession(),
) {
  const root = await mkdtemp(join(tmpdir(), "colleague-line-coordinator-"));
  roots.push(root);
  const stateRoot = join(root, "state");
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);
  const config = new ConfigStore({ configPath: join(root, "config.json"), stateRoot });
  await config.init({ owner: { id: "owner", name: "Owner" } });
  await config.addWorkspace({ id: "docs", name: "Docs", summary: "Docs", root: workspaceRoot });
  const added = await config.addClient({ id: "client", tailcatKey: "nodekey:first" });
  const client = (await config.authenticate(added.bearer))!;
  const sessions = new RuntimeSessionStore(stateRoot);
  const runtime = new PiRuntime({
    createSession: async (workspace, session) => createSession(workspace, session),
  });
  const desired = await config.readEffective();
  const coordinator = await RuntimeCoordinator.create({ config, sessions, runtime, desired });
  return { root, stateRoot, config, sessions, runtime, coordinator, desired, client };
}

describe("RuntimeCoordinator", () => {
  test("keeps one durable Pi session ID for a Client and Workspace", async () => {
    const { coordinator, sessions, client } = await fixture();
    const signal = new AbortController().signal;

    await coordinator.answer({ client, workspaceId: "docs", question: "one", signal });
    const first = (await sessions.list())[0]!;
    await coordinator.answer({ client, workspaceId: "docs", question: "two", signal });

    expect((await sessions.list())[0]?.id).toBe(first.id);
    await coordinator.close();
  });

  test("aborts revocation and removes binding without deleting Pi archive", async () => {
    let rejectPrompt: ((error: Error) => void) | undefined;
    let promptStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      promptStarted = resolve;
    });
    const managed = fakeSession();
    managed.prompt = () => {
      promptStarted();
      return new Promise<void>((_resolve, reject) => {
        rejectPrompt = reject;
      });
    };
    managed.abort = async () => {
      rejectPrompt?.(new DOMException("Aborted", "AbortError"));
    };
    const { root, coordinator, config, sessions, client } = await fixture(() => managed);
    const pending = coordinator.answer({
      client,
      workspaceId: "docs",
      question: "running",
      signal: new AbortController().signal,
    });
    await started;
    const archive = join(root, "owner-global-pi-session.jsonl");
    await writeFile(archive, "history");

    await config.revokeClient("client");
    const reconciliation = coordinator.reconcile(await config.readEffective());
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await reconciliation;

    expect(await sessions.list()).toEqual([]);
    expect(await Bun.file(archive).text()).toBe("history");
    await expect(
      coordinator.answer({
        client,
        workspaceId: "docs",
        question: "late",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await coordinator.close();
  });

  test("waits for in-flight Pi creation before removing a binding", async () => {
    let releaseCreation!: () => void;
    const creationBarrier = new Promise<void>((resolve) => {
      releaseCreation = resolve;
    });
    let creationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      creationStarted = resolve;
    });
    let disposals = 0;
    const current = await fixture(async () => {
      creationStarted();
      await creationBarrier;
      const managed = fakeSession();
      managed.dispose = async () => {
        disposals++;
      };
      return managed;
    });
    const pending = current.coordinator.answer({
      client: current.client,
      workspaceId: "docs",
      question: "running",
      signal: new AbortController().signal,
    });
    await started;
    await current.config.revokeClient("client");
    let reconciled = false;
    const reconciliation = current.coordinator
      .reconcile(await current.config.readEffective())
      .then(() => {
        reconciled = true;
      });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await Bun.sleep(0);
    expect(reconciled).toBe(false);

    releaseCreation();
    await reconciliation;
    expect(disposals).toBe(1);
    expect(await current.sessions.list()).toEqual([]);
    await current.coordinator.close();
  });

  test("credential rotation restarts memory but preserves the Pi session ID", async () => {
    let creations = 0;
    const { coordinator, config, sessions, client } = await fixture(() => {
      creations++;
      return fakeSession();
    });
    const input = {
      client,
      workspaceId: "docs",
      question: "one",
      signal: new AbortController().signal,
    };
    await coordinator.answer(input);
    const before = (await sessions.list())[0]!;

    const rotated = await config.rotateClient("client", "nodekey:second");
    await coordinator.reconcile(await config.readEffective());
    await expect(coordinator.answer({ ...input, question: "old" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await coordinator.answer({
      ...input,
      client: (await config.authenticate(rotated.bearer))!,
      question: "two",
    });

    expect((await sessions.list())[0]?.id).toBe(before.id);
    expect(creations).toBe(2);
    await coordinator.close();
  });

  test("linearizes admission before credential rotation", async () => {
    const { coordinator, config, sessions, client } = await fixture();
    const originalGetOrCreate = sessions.getOrCreate.bind(sessions);
    let entered!: () => void;
    const admissionEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const admissionBarrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    sessions.getOrCreate = async (...arguments_) => {
      entered();
      await admissionBarrier;
      return originalGetOrCreate(...arguments_);
    };
    const admitted = coordinator.answer({
      client,
      workspaceId: "docs",
      question: "before rotation",
      signal: new AbortController().signal,
    });
    await admissionEntered;
    let rotated = false;
    const rotation = config.rotateClient("client", "nodekey:second").then(() => {
      rotated = true;
    });
    await Bun.sleep(10);
    expect(rotated).toBe(false);

    release();
    await admitted;
    await rotation;
    expect(rotated).toBe(true);
    await coordinator.close();
  });

  test("Workspace removal purges only that binding scope", async () => {
    const { root, coordinator, config, sessions, client } = await fixture();
    const codeRoot = join(root, "code");
    await mkdir(codeRoot);
    await config.addWorkspace({ id: "code", name: "Code", summary: "Code", root: codeRoot });
    await coordinator.reconcile(await config.readEffective());
    const signal = new AbortController().signal;
    await coordinator.answer({ client, workspaceId: "docs", question: "docs", signal });
    await coordinator.answer({ client, workspaceId: "code", question: "code", signal });
    const codeSession = (await sessions.list()).find((session) => session.workspaceId === "code")!;

    await config.removeWorkspace("docs");
    await coordinator.reconcile(await config.readEffective());

    expect(await sessions.list()).toEqual([codeSession]);
    await coordinator.close();
  });

  test("startup removes bindings for absent Clients and Workspaces", async () => {
    const initial = await fixture();
    const keep = await initial.sessions.getOrCreate("client", "docs");
    await initial.sessions.getOrCreate("revoked", "docs");
    await initial.sessions.getOrCreate("client", "removed");
    await initial.coordinator.close();
    const runtime = new PiRuntime({ createSession: async () => fakeSession() });

    const coordinator = await RuntimeCoordinator.create({
      config: initial.config,
      sessions: initial.sessions,
      runtime,
      desired: await initial.config.readEffective(),
    });

    expect((await initial.sessions.list()).map(({ id }) => id)).toEqual([keep.id]);
    await coordinator.close();
  });
});

function fakeSession(): ManagedPiSession {
  return {
    prompt: async () => {},
    isAlive: () => true,
    getLastAssistantText: () => "answer",
    clearQueue: async () => {},
    abort: async () => {},
    waitForIdle: async () => {},
    dispose: async () => {},
  };
}
