import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import packageJson from "../package.json";
import { ClientApplication } from "./client-application";
import type { ClientConfigStore } from "./client-config";
import { ColleagueLineError } from "./errors";
import { createMcpHttpServer, type McpGateway, type McpHttpOptions } from "./mcp";

export interface ClientMcpOptions extends Omit<McpHttpOptions, "authenticate" | "createServer"> {
  app: ClientApplication;
  config: Pick<ClientConfigStore, "authenticateLocal">;
}

export function createClientMcp(options: ClientMcpOptions): McpGateway {
  return createMcpHttpServer({
    ...options,
    authenticate: (bearer) => options.config.authenticateLocal(bearer),
    createServer: () => createClientServer(options.app),
  });
}

function createClientServer(app: ClientApplication): McpServer {
  const server = new McpServer({ name: "colleague-line-client", version: packageJson.version });
  server.registerTool(
    "list_lines",
    {
      description: "List configured Lines and each Line's public Workspace metadata.",
      outputSchema: {
        lines: z.array(
          z.object({
            id: z.string(),
            available: z.boolean(),
            owner: z
              .object({ id: z.string(), name: z.string(), summary: z.string().optional() })
              .optional(),
            workspaces: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                summary: z.string(),
                available: z.boolean(),
              }),
            ),
          }),
        ),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (extra) => toolResult(() => app.listLines(extra.signal).then((lines) => ({ lines }))),
  );
  server.registerTool(
    "ask",
    {
      description: "Ask one exact Workspace on one exact Line.",
      inputSchema: {
        line: z.string().min(1),
        workspace: z.string().min(1),
        question: z.string().min(1).max(20_000),
      },
      outputSchema: { line: z.string(), workspace: z.string(), answer: z.string() },
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async ({ line, workspace, question }, extra) =>
      toolResult(() => app.ask({ line, workspace, question }, extra.signal)),
  );
  return server;
}

async function toolResult<T extends object>(read: () => Promise<T>) {
  try {
    const structuredContent = (await read()) as Record<string, unknown>;
    return {
      content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
      structuredContent,
    };
  } catch (error) {
    const safe =
      error instanceof ColleagueLineError
        ? `${error.code}: ${error.message}`
        : error instanceof DOMException && error.name === "AbortError"
          ? "CANCELLED: Request cancelled"
          : "LINE_UNAVAILABLE: Line unavailable";
    return { content: [{ type: "text" as const, text: safe }], isError: true };
  }
}
