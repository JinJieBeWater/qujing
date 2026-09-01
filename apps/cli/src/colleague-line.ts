import type { ConfigStore } from "./config";
import { ColleagueLineError } from "./errors";
import type { AskRequest, AskResult, ClientIdentity, ColleagueLine, WorkspaceList } from "./types";

interface AnswerInput {
  client: ClientIdentity;
  workspaceId: string;
  question: string;
  signal: AbortSignal;
}

export interface ColleagueLineDependencies {
  config: ConfigStore;
  answer(input: AnswerInput): Promise<string>;
}

export function createColleagueLine(dependencies: ColleagueLineDependencies): ColleagueLine {
  return {
    async listWorkspaces(client: ClientIdentity): Promise<WorkspaceList> {
      await requireClient(dependencies.config, client);
      const config = await dependencies.config.read();
      const owner =
        config.owner.summary === undefined
          ? { id: config.owner.id, name: config.owner.name }
          : { id: config.owner.id, name: config.owner.name, summary: config.owner.summary };
      return { owner, workspaces: await dependencies.config.listPublicWorkspaces() };
    },

    async ask(request: AskRequest, signal: AbortSignal): Promise<AskResult> {
      await requireClient(dependencies.config, request.client);
      if (request.question.trim().length === 0) {
        throw new ColleagueLineError("INVALID_QUESTION", "Question must not be empty");
      }
      if (request.question.length > 20_000) {
        throw new ColleagueLineError(
          "INVALID_QUESTION",
          "Question must not exceed 20,000 characters",
        );
      }
      const workspace = await dependencies.config.getWorkspace(request.workspace);
      if (!workspace)
        throw new ColleagueLineError(
          "WORKSPACE_NOT_FOUND",
          `Workspace not found: ${request.workspace}`,
        );
      if (!(await dependencies.config.isWorkspaceAvailable(workspace.root))) {
        throw new ColleagueLineError(
          "WORKSPACE_UNAVAILABLE",
          `Workspace unavailable: ${request.workspace}`,
        );
      }
      signal.throwIfAborted();
      const answer = await dependencies.answer({
        client: request.client,
        workspaceId: request.workspace,
        question: request.question,
        signal,
      });
      return { workspace: request.workspace, answer };
    },
  };
}

async function requireClient(config: ConfigStore, client: ClientIdentity): Promise<void> {
  if (!(await config.withLock(() => config.hasClient(client))))
    throw new ColleagueLineError("UNAUTHORIZED", "Client is not authorized");
}
