import { Effect, Layer, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/unstable/ai";
import { ClientApplication } from "./client-application";
import type { ClientConfigStore } from "./client-config";
import { QujingError } from "./errors";
import {
  createEffectMcpSession,
  createMcpHttpServer,
  McpToolFailure,
  withAbortSignal,
  type EffectMcpSession,
  type McpGateway,
  type McpHttpOptions,
} from "./mcp";
import { ClientAskResult, ClientLinesResult, NonEmptyString } from "./schemas";

export interface ClientMcpOptions extends Omit<
  McpHttpOptions,
  "authenticateEffect" | "createServer"
> {
  app: ClientApplication;
  config: Pick<ClientConfigStore, "authenticateLocalEffect">;
}

export function createClientMcp(options: ClientMcpOptions): McpGateway {
  return createMcpHttpServer({
    ...options,
    authenticateEffect: (bearer) => options.config.authenticateLocalEffect(bearer),
    createServer: () => createClientServer(options.app, options.allowedOrigins),
  });
}

function createClientServer(
  app: ClientApplication,
  allowedOrigins: readonly string[],
): EffectMcpSession {
  const listLines = Tool.make("list_lines", {
    description: "List configured Lines and each Line's public Workspace metadata.",
    success: ClientLinesResult,
    failure: McpToolFailure,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.OpenWorld, false);
  const ask = Tool.make("ask", {
    description: "Ask one exact Workspace on one exact Line for colleague consultation.",
    parameters: Schema.Struct({
      line: NonEmptyString,
      workspace: NonEmptyString,
      question: Schema.String,
    }),
    success: ClientAskResult,
    failure: McpToolFailure,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Idempotent, false)
    .annotate(Tool.Destructive, true)
    .annotate(Tool.OpenWorld, true);
  const toolkit = Toolkit.make(listLines, ask);
  const handlers = toolkit.toLayer({
    list_lines: () =>
      withAbortSignal((signal) =>
        app.listLinesEffect(signal).pipe(
          Effect.map((lines) => ({ lines })),
          Effect.mapError(clientToolFailure),
        ),
      ),
    ask: ({ line, workspace, question }) =>
      withAbortSignal((signal) =>
        app
          .askEffect({ line, workspace, question }, signal)
          .pipe(Effect.mapError(clientToolFailure)),
      ),
  });
  const registrations = Layer.effectDiscard(McpServer.registerToolkit(toolkit)).pipe(
    Layer.provide(handlers),
  );
  return createEffectMcpSession("qujing-client", registrations, allowedOrigins);
}

function clientToolFailure(error: unknown): McpToolFailure {
  return new McpToolFailure({
    message:
      error instanceof QujingError
        ? `${error.code}: ${error.message}`
        : error instanceof DOMException && error.name === "AbortError"
          ? "CANCELLED: Request cancelled"
          : "LINE_UNAVAILABLE: Line unavailable",
  });
}
