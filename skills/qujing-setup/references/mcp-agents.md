# MCP Agent configuration

Configure Agent’s native Streamable HTTP MCP support. Check installed Agent’s current documentation before editing config; field shapes change.

## Contract

- URL: `http://127.0.0.1:43111/mcp` unless `qj init --port` chose another loopback port
- Header: `Authorization: Bearer <local-bearer>`
- Tool-call timeout: at least 135 seconds
- Tools: exactly `list_peers`, `ask`
- Prerequisite: `qj serve` or Qujing service running

Local bearer comes only from `qj init` or `qj token rotate`. Store it in Agent secret storage or private user config. It is not any Peer remote bearer. Never commit it.

Generic shape; verify Agent-specific schema:

```json
{
  "type": "http",
  "url": "http://127.0.0.1:43111/mcp",
  "headers": {
    "Authorization": "Bearer <local-bearer>"
  }
}
```

## Timeout compatibility

Set the tool-call timeout separately using the client's schema and units. These settings were checked against first-party documentation on 2026-09-07; they are configuration evidence, not live Qujing compatibility results.

| Agent              | Setting                                    | Unit    | Minimum  | Source                                                                                                    |
| ------------------ | ------------------------------------------ | ------- | -------- | --------------------------------------------------------------------------------------------------------- |
| Claude Code        | `MCP_TOOL_TIMEOUT` or per-server `timeout` | ms      | `135000` | [Environment variables](https://code.claude.com/docs/en/env-vars)                                         |
| OpenAI Codex CLI   | `mcp_servers.<id>.tool_timeout_sec`        | seconds | `135`    | [Configuration reference](https://developers.openai.com/codex/config-reference)                           |
| Gemini CLI         | `mcpServers.<id>.timeout`                  | ms      | `135000` | [MCP servers](https://geminicli.com/docs/tools/mcp-server/)                                               |
| GitHub Copilot CLI | per-server `timeout`                       | ms      | `135000` | [CLI reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference) |
| OpenCode v2        | `mcp.timeout.execution`                    | ms      | `135000` | [V2 MCP servers](https://opencode.ai/v2/docs/mcp-servers)                                                 |

[Cline](https://github.com/cline/cline/blob/main/docs/mcp/mcp-overview.mdx) documents configurable MCP request timeouts, but verify the installed version's field and unit before configuring it. Roo Code, Zed, Goose, Cursor, and VS Code Copilot Chat also require version-specific timeout verification before declaring compatibility. A startup or tool-discovery timeout is not evidence of a tool-call timeout. For Claude Code, also check any explicitly configured MCP idle timeout; it must not cut calls short.

For client timeout acceptance, use a separate test MCP server with a delayed tool, not a real Qujing `ask`: Qujing's Runtime deadline is 120 seconds. For example, configure the client for 150 seconds, verify a 140-second delayed response, then test cancellation separately. Record client version and transport. Qujing integration checks below remain necessary.

## Verification

1. Restart/reload Agent after configuration.
2. Require exactly `list_peers` and `ask`; presence of `list_workspaces` means wrong endpoint.
3. Call `list_peers`; reject any roots, credentials, model, Runtime, session, or Tailcat details.
4. Call `ask` with exact Peer ID, Workspace ID, and non-empty question.
5. Ask follow-up with same Peer and Workspace. No thread/conversation parameter exists.
6. Pair second Peer without adding another Agent MCP server.
