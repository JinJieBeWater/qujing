import { Effect, Layer, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/unstable/ai";
import { AgentApplication } from "./agent-application";
import type { AgentConfigStore } from "./agent-config";
import { QujingError } from "./errors";
import {
  createEffectMcpSession,
  createMcpHttpServer,
  McpToolFailure,
  withAbortSignal,
  type EffectMcpSession,
  type McpHttpServer,
  type McpHttpOptions,
} from "./mcp";
import { AgentAskResult, AgentPeersResult, NonEmptyString } from "./schemas";

export interface AgentMcpOptions extends Omit<
  McpHttpOptions,
  "authenticateEffect" | "createServer"
> {
  app: AgentApplication;
  config: Pick<AgentConfigStore, "authenticateLocalEffect">;
}

export function createAgentMcp(options: AgentMcpOptions): McpHttpServer {
  return createMcpHttpServer({
    ...options,
    authenticateEffect: (bearer) => options.config.authenticateLocalEffect(bearer),
    createServer: (_node) => createAgentServer(options.app, options.allowedOrigins),
  });
}

function createAgentServer(
  app: AgentApplication,
  allowedOrigins: readonly string[],
): EffectMcpSession {
  const listPeers = Tool.make("list_peers", {
    description: "List configured Peers and each Peer's public Workspace metadata.",
    success: AgentPeersResult,
    failure: McpToolFailure,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.OpenWorld, false);
  const ask = Tool.make("ask", {
    description: "Ask one exact Workspace on one exact Peer for colleague consultation.",
    parameters: Schema.Struct({
      peer: NonEmptyString,
      workspace: NonEmptyString,
      question: Schema.String,
    }),
    success: AgentAskResult,
    failure: McpToolFailure,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Idempotent, false)
    .annotate(Tool.Destructive, true)
    .annotate(Tool.OpenWorld, true);
  const toolkit = Toolkit.make(listPeers, ask);
  const handlers = toolkit.toLayer({
    list_peers: () =>
      withAbortSignal((signal) =>
        app.listPeersEffect(signal).pipe(
          Effect.map((peers) => ({ peers })),
          Effect.mapError(agentToolFailure),
        ),
      ),
    ask: ({ peer, workspace, question }) =>
      withAbortSignal((signal) =>
        app
          .askEffect({ peer, workspace, question }, signal)
          .pipe(Effect.mapError(agentToolFailure)),
      ),
  });
  const registrations = Layer.effectDiscard(McpServer.registerToolkit(toolkit)).pipe(
    Layer.provide(handlers),
  );
  return createEffectMcpSession("qujing-agent", registrations, allowedOrigins);
}

function agentToolFailure(error: unknown): McpToolFailure {
  return new McpToolFailure({
    message:
      error instanceof QujingError
        ? `${error.code}: ${error.message}`
        : error instanceof DOMException && error.name === "AbortError"
          ? "CANCELLED: Request cancelled"
          : "PEER_UNAVAILABLE: Peer unavailable",
  });
}
