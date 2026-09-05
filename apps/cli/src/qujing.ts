import { Effect } from "effect";
import type { ConfigStore } from "./config";
import { QujingError } from "./errors";
import type { RuntimeCoordinator } from "./runtime/coordinator";
import type { AskRequest, PeerCredentialIdentity, PeerAskResult, PeerWorkspaces } from "./schemas";

export interface QujingDependencies {
  config: ConfigStore;
  coordinator: Pick<RuntimeCoordinator, "answerEffect">;
}

export interface QujingEffectApi {
  listWorkspacesEffect(peer: PeerCredentialIdentity): Effect.Effect<PeerWorkspaces, unknown>;
  askEffect(request: AskRequest, signal: AbortSignal): Effect.Effect<PeerAskResult, unknown>;
}

export function createQujing(dependencies: QujingDependencies): QujingEffectApi {
  const listWorkspacesEffect = (peer: PeerCredentialIdentity) =>
    Effect.gen(function* () {
      const config = yield* dependencies.config.withLockEffect(
        dependencies.config
          .readEffectiveEffect()
          .pipe(
            Effect.flatMap((config) =>
              config.peers.some(
                (entry) => entry.id === peer.id && entry.bearerHash === peer.credentialVersion,
              )
                ? Effect.succeed(config)
                : Effect.fail(new QujingError("UNAUTHORIZED", "Agent is not authorized")),
            ),
          ),
      );
      const workspaces = yield* Effect.all(
        config.workspaces.map(({ id, name, summary, root }) =>
          dependencies.config
            .isWorkspaceAvailableEffect(root)
            .pipe(Effect.map((available) => ({ id, name, summary, available }))),
        ),
        { concurrency: "unbounded" },
      );
      const node =
        config.node.summary === undefined
          ? { id: config.node.id, name: config.node.name }
          : {
              id: config.node.id,
              name: config.node.name,
              summary: config.node.summary,
            };
      return { node, workspaces };
    });

  const askEffect = (request: AskRequest, signal: AbortSignal) =>
    dependencies.coordinator
      .answerEffect({
        peer: request.peer,
        workspaceId: request.workspace,
        question: request.question,
        signal,
      })
      .pipe(Effect.map((answer) => ({ workspace: request.workspace, answer })));

  return {
    listWorkspacesEffect,
    askEffect,
  };
}
