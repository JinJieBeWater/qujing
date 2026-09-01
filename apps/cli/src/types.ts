export interface ClientIdentity {
  id: string;
  credentialVersion: string;
}

export interface OwnerMetadata {
  id: string;
  name: string;
  summary?: string;
}

export interface PublicWorkspace {
  id: string;
  name: string;
  summary: string;
  available: boolean;
}

export interface WorkspaceList {
  owner: OwnerMetadata;
  workspaces: PublicWorkspace[];
}

export interface AskRequest {
  client: ClientIdentity;
  workspace: string;
  question: string;
}

export interface AskResult {
  workspace: string;
  answer: string;
}

export interface ColleagueLine {
  listWorkspaces(client: ClientIdentity): Promise<WorkspaceList>;
  ask(request: AskRequest, signal: AbortSignal): Promise<AskResult>;
}
