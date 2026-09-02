import { Effect } from "effect";
import type { ConfigStore } from "./config";
import { ColleagueLineError } from "./errors";
import type { RuntimeCoordinator } from "./runtime/coordinator";
import type { AskRequest, ClientIdentity, LineAskResult, LineWorkspaces } from "./schemas";

export interface ColleagueLineDependencies {
  config: ConfigStore;
  coordinator: Pick<RuntimeCoordinator, "answerEffect">;
}

export interface ColleagueLineEffectApi {
  listWorkspacesEffect(client: ClientIdentity): Effect.Effect<LineWorkspaces, unknown>;
  askEffect(request: AskRequest, signal: AbortSignal): Effect.Effect<LineAskResult, unknown>;
}

export function createColleagueLine(
  dependencies: ColleagueLineDependencies,
): ColleagueLineEffectApi {
  const listWorkspacesEffect = (client: ClientIdentity) =>
    Effect.gen(function* () {
      yield* requireClientEffect(dependencies.config, client);
      const [config, workspaces] = yield* Effect.all([
        dependencies.config.readEffect(),
        dependencies.config.listPublicWorkspacesEffect(),
      ]);
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

function requireClientEffect(config: ConfigStore, client: ClientIdentity) {
  return config.withLockEffect(
    config
      .hasClientEffect(client)
      .pipe(
        Effect.flatMap((authorized) =>
          authorized
            ? Effect.void
            : Effect.fail(new ColleagueLineError("UNAUTHORIZED", "Client is not authorized")),
        ),
      ),
  );
}
