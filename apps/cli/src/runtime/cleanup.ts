import { RuntimeSessionStore, type RuntimeSession } from "./sessions";
import { Effect } from "effect";

interface ActiveRuntimeState {
  clientIds: string[];
  workspaceIds: string[];
}

export function purgeRemovedRuntimeSessionsEffect(
  active: ActiveRuntimeState,
  store: RuntimeSessionStore,
) {
  const clientIds = new Set(active.clientIds);
  const workspaceIds = new Set(active.workspaceIds);
  return Effect.gen(function* () {
    const removed = yield* store.matchingEffect(
      (session) => !clientIds.has(session.clientId) || !workspaceIds.has(session.workspaceId),
    );
    yield* Effect.all(
      removed.map((session) => store.removeEffect(session)),
      {
        concurrency: "unbounded",
      },
    );
    return removed;
  });
}

export const purgeClientRuntimeSessionsEffect = (clientId: string, store: RuntimeSessionStore) =>
  purgeRuntimeSessionsEffect((session) => session.clientId === clientId, store);

export const purgeWorkspaceRuntimeSessionsEffect = (
  workspaceId: string,
  store: RuntimeSessionStore,
) => purgeRuntimeSessionsEffect((session) => session.workspaceId === workspaceId, store);

function purgeRuntimeSessionsEffect(
  predicate: (session: RuntimeSession) => boolean,
  store: RuntimeSessionStore,
) {
  return Effect.gen(function* () {
    const sessions = yield* store.matchingEffect(predicate);
    yield* Effect.all(
      sessions.map((session) => store.removeEffect(session)),
      {
        concurrency: "unbounded",
      },
    );
    return sessions;
  });
}
