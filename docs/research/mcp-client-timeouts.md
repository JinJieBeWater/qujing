# MCP Client tool-call timeout compatibility

Research snapshot: 2026-08-31.

Question: can mainstream coding agents wait at least 135 seconds for one MCP `tools/call`?

`tools/call` timeout and MCP server startup timeout are different. Colleague Line requires at least 135 seconds for its 120-second `ask` limit, 5-second abort settlement, and transport/scheduler margin.

## Result

| Client                | Can set tool-call timeout ≥135 s? | Relevant setting                                                  | Assessment                                                                                                                  |
| --------------------- | --------------------------------: | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Pi + `pi-mcp-adapter` |                               Yes | `requestTimeoutMs: 135000`                                        | Supported                                                                                                                   |
| Claude Code           |                               Yes | per-server `timeout` or `MCP_TOOL_TIMEOUT`, ms                    | Supported on current releases; older releases had HTTP timeout regressions                                                  |
| OpenAI Codex CLI      |                               Yes | `[mcp_servers.<id>] tool_timeout_sec = 135`                       | Supported                                                                                                                   |
| Gemini CLI            |                               Yes | `mcpServers.<name>.timeout: 135000`, ms                           | Supported                                                                                                                   |
| GitHub Copilot CLI    |                               Yes | per-server `timeout: 135000`, ms                                  | Supported                                                                                                                   |
| Cline                 |                               Yes | per-server `timeout: 135`, seconds                                | Supported                                                                                                                   |
| Roo Code              |                               Yes | per-server `timeout: 135`, seconds                                | Supported                                                                                                                   |
| OpenCode              |                               Yes | per-server request timeout; exact shape depends on config version | Supported, but pin and test target release                                                                                  |
| Zed                   |                               Yes | global `context_server_timeout: 135`, seconds                     | Supported; stdio lacks per-server override                                                                                  |
| Goose                 |                               Yes | extension `timeout: 135`, seconds                                 | Supported                                                                                                                   |
| Cursor                |             No documented setting | none                                                              | Blocked until live probe proves current release waits ≥135 s; first-party forum reports shorter fixed ceilings              |
| VS Code Copilot Chat  |                No exposed setting | none                                                              | Cannot configure, but current request path appears cancellation-driven rather than short fixed-timeout; live probe required |

## Practical conclusion

Only **Cursor** is presently a likely compatibility blocker. It exposes no timeout control and first-party forum evidence reports roughly 30–60 second ceilings.

**VS Code Copilot Chat** also exposes no timeout control, but this is a different failure mode: first-party issue text and current VS Code MCP request path indicate calls may wait indefinitely until cancellation. That cannot guarantee an exact 135-second client deadline, but it should not violate the lower-bound requirement by timing out early. Treat it as provisional until tested.

All other surveyed clients expose a setting capable of at least 135 seconds. Do not rely on defaults: several default below 135 seconds.

Compatibility should be behavior-based:

1. Configure 135 seconds or higher when the client exposes a setting.
2. Run a 140-second delayed `ask` probe on each supported client/version.
3. Mark a client/version supported only when the call completes and cancellation also works.
4. Re-run the probe on client upgrades; timeout behavior has regressed before in Claude Code and Gemini CLI.

## Primary sources

- Pi MCP adapter: [`README.md` v2.31.0](https://github.com/nicobailon/pi-mcp-adapter/blob/v2.31.0/README.md) documents global and per-server `requestTimeoutMs` for live MCP calls.
- Claude Code: [MCP docs](https://code.claude.com/docs/en/mcp), [environment variables](https://code.claude.com/docs/en/env-vars), [timeout regression #50289](https://github.com/anthropics/claude-code/issues/50289).
- OpenAI Codex CLI: [config reference](https://developers.openai.com/codex/config-file/config-reference), [MCP config source](https://github.com/openai/codex/blob/main/codex-rs/config/src/mcp_types.rs).
- Gemini CLI: [MCP server docs](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md), [MCP client source](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/tools/mcp-client.ts).
- GitHub Copilot CLI: [CLI command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference).
- Cline: [MCP schema](https://github.com/cline/cline/blob/main/apps/vscode/src/services/mcp/schemas.ts), [MCP docs](https://github.com/cline/cline/blob/main/docs/mcp/mcp-overview.mdx).
- Roo Code: [MCP tool docs](https://github.com/RooCodeInc/Roo-Code/blob/main/apps/docs/docs/advanced-usage/available-tools/use-mcp-tool.md).
- OpenCode: [MCP docs](https://opencode.ai/docs/mcp-servers/), [MCP config source](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/v1/config/mcp.ts), [tool-call source](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/mcp/catalog.ts).
- Zed: [project settings source](https://github.com/zed-industries/zed/blob/main/crates/project/src/project_settings.rs), [context server settings source](https://github.com/zed-industries/zed/blob/main/crates/settings_content/src/project.rs).
- Goose: [config docs](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/config-files.md), [extension source](https://github.com/aaif-goose/goose/blob/main/crates/goose/src/config/extensions.rs).
- Cursor: [MCP docs](https://prod.cursor.com/help/customization/mcp), [first-party forum timeout thread](https://forum.cursor.com/t/mcp-tool-calling-timeout/49149).
- VS Code Copilot Chat: [MCP config reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration), [timeout feature request #14130](https://github.com/microsoft/vscode-copilot-release/issues/14130), [VS Code MCP request handler](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/mcp/common/mcpServerRequestHandler.ts).

## Evidence limits

- Cursor is closed-source. “Not configurable” rests on official configuration docs plus first-party staff/forum evidence, not source proof.
- Client behavior changes by release. Configuration presence alone is insufficient; delayed-call probe is acceptance evidence.
- Startup timeout settings do not prove tool-call timeout behavior.
