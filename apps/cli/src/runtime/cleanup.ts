import { RuntimeSessionStore, type RuntimeSession } from "./sessions";

interface ActiveRuntimeState {
  clientIds: string[];
  workspaceIds: string[];
}

export async function purgeRemovedRuntimeSessions(
  active: ActiveRuntimeState,
  store: RuntimeSessionStore,
): Promise<RuntimeSession[]> {
  const clientIds = new Set(active.clientIds);
  const workspaceIds = new Set(active.workspaceIds);
  const removed = await store.matching(
    (session) => !clientIds.has(session.clientId) || !workspaceIds.has(session.workspaceId),
  );
  await Promise.all(removed.map((session) => store.remove(session)));
  return removed;
}

export async function purgeClientRuntimeSessions(
  clientId: string,
  store: RuntimeSessionStore,
): Promise<RuntimeSession[]> {
  const sessions = await store.matching((session) => session.clientId === clientId);
  await Promise.all(sessions.map((session) => store.remove(session)));
  return sessions;
}

export async function purgeWorkspaceRuntimeSessions(
  workspaceId: string,
  store: RuntimeSessionStore,
): Promise<RuntimeSession[]> {
  const sessions = await store.matching((session) => session.workspaceId === workspaceId);
  await Promise.all(sessions.map((session) => store.remove(session)));
  return sessions;
}
