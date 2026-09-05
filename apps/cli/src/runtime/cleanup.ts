import { RuntimeSessionStore, type RuntimeSession } from "./sessions";
import { Effect } from "effect";

interface ActiveRuntimeState {
  peerIds: string[];
  workspaceIds: string[];
}

export function purgeRemovedRuntimeSessionsEffect(
  active: ActiveRuntimeState,
  store: RuntimeSessionStore,
) {
  const peerIds = new Set(active.peerIds);
  const workspaceIds = new Set(active.workspaceIds);
  return Effect.gen(function* () {
    const removed = yield* store.matchingEffect(
      (session) => !peerIds.has(session.peerId) || !workspaceIds.has(session.workspaceId),
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

export const purgePeerRuntimeSessionsEffect = (peerId: string, store: RuntimeSessionStore) =>
  purgeRuntimeSessionsEffect((session) => session.peerId === peerId, store);

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
