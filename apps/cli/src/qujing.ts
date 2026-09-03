import { Effect } from "effect";
import type { ConfigStore } from "./config";
import { QujingError } from "./errors";
import type { RuntimeCoordinator } from "./runtime/coordinator";
import type { AskRequest, ClientIdentity, LineAskResult, LineWorkspaces } from "./schemas";

export interface QujingDependencies {
  config: ConfigStore;
  coordinator: Pick<RuntimeCoordinator, "answerEffect">;
}

export interface QujingEffectApi {
  listWorkspacesEffect(client: ClientIdentity): Effect.Effect<LineWorkspaces, unknown>;
  askEffect(request: AskRequest, signal: AbortSignal): Effect.Effect<LineAskResult, unknown>;
}

export function createQujing(dependencies: QujingDependencies): QujingEffectApi {
  const listWorkspacesEffect = (client: ClientIdentity) =>
    Effect.gen(function* () {
      const config = yield* dependencies.config.withLockEffect(
        dependencies.config
          .readEffectiveEffect()
          .pipe(
            Effect.flatMap((config) =>
              config.clients.some(
                (entry) => entry.id === client.id && entry.bearerHash === client.credentialVersion,
              )
                ? Effect.succeed(config)
                : Effect.fail(new QujingError("UNAUTHORIZED", "Client is not authorized")),
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
      const owner =
        config.owner.summary === undefined
          ? { id: config.owner.id, name: config.owner.name }
          : {
              id: config.owner.id,
              name: config.owner.name,
              summary: config.owner.summary,
            };
      return { owner, workspaces };
    });

  const askEffect = (request: AskRequest, signal: AbortSignal) =>
    dependencies.coordinator
      .answerEffect({
        client: request.client,
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
