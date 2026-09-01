# MCP Agent configuration

Configure Agent’s native Streamable HTTP MCP support. Check installed Agent’s current documentation before editing config; field shapes change.

## Contract

- URL: `http://127.0.0.1:43111/mcp` unless `colleague-line client init --port` chose another loopback port
- Header: `Authorization: Bearer <local-bearer>`
- Tool-call timeout: at least 135 seconds
- Tools: exactly `list_lines`, `ask`
- Prerequisite: `colleague-line client serve` or Client role service running

Local bearer comes only from `colleague-line client init` or `colleague-line client token rotate`. Store it in Agent secret storage or private user config. It is not any Line remote bearer. Never commit it.

Generic shape; verify Agent-specific schema:

```json
{
  "type": "http",
  "url": "http://127.0.0.1:43111/mcp",
  "headers": {
    "Authorization": "Bearer <local-bearer>"
  },
  "timeout": 135000
}
```

## Timeout compatibility

| Agent              | Setting                                    |    Unit | Action                                                                        |
| ------------------ | ------------------------------------------ | ------: | ----------------------------------------------------------------------------- |
| Claude Code        | `MCP_TOOL_TIMEOUT` or per-server `timeout` |      ms | Set `135000` or higher                                                        |
| OpenAI Codex CLI   | `tool_timeout_sec`                         | seconds | Set `135` or higher                                                           |
| Gemini CLI         | per-server `timeout`                       |      ms | Keep at least `135000`                                                        |
| GitHub Copilot CLI | per-server `timeout`                       |      ms | Set `135000` or higher                                                        |
| Cline              | per-server `timeout`                       | seconds | Set `135` or higher                                                           |
| Roo Code           | per-server `timeout`                       | seconds | Set `135` or higher                                                           |
| OpenCode v2        | `mcp.timeout.execution`                    |      ms | Verify installed v2 schema and set `135000` or higher; do not rely on default |
| Zed                | `context_server_timeout`                   | seconds | Set `135` or higher                                                           |
| Goose              | extension `timeout`                        | seconds | Keep at least `135`                                                           |

Cursor has no verified configurable long tool timeout and is unsupported. VS Code Copilot Chat remains provisional until tool timeout is verified.

## Verification

1. Restart/reload Agent after configuration.
2. Require exactly `list_lines` and `ask`; presence of `list_workspaces` means wrong endpoint.
3. Call `list_lines`; reject any roots, credentials, model, Runtime, session, or Tailcat details.
4. Call `ask` with exact Line ID, Workspace ID, and non-empty question.
5. Ask follow-up with same Line and Workspace. No thread/conversation parameter exists.
6. Pair second Line without adding another Agent MCP server.
