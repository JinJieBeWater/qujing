# MCP Agent tool-call timeout compatibility

Documentation review: 2026-09-07. This is configuration evidence, not a live client acceptance matrix.

Qujing requires a client tool-call timeout of at least 135 seconds for its 120-second Runtime deadline, 5-second abort settlement, and transport/scheduler margin. MCP startup, discovery, idle, and tool-execution limits are distinct; raising only startup timeout does not establish compatibility.

## Verified configuration

The maintained settings, units, and first-party source links are in [MCP Agent configuration](../../skills/qujing-setup/references/mcp-agents.md#timeout-compatibility).

- Claude Code documents `MCP_TOOL_TIMEOUT` in milliseconds and per-server overrides. An explicitly configured shorter MCP idle timeout can still end a call early.
- Codex documents per-server `tool_timeout_sec` in seconds.
- Gemini CLI and GitHub Copilot CLI document per-server request/tool-call timeout settings in milliseconds.
- OpenCode v2 documents execution timeouts separately from startup and catalog timeouts. Its schema must not be copied into a v1 configuration.
- Cline's official MCP documentation confirms configurable request timeouts, but this review did not verify its current numeric field/unit. Use the installed version's schema before prescribing a value.

Roo Code, Zed, Goose, Pi MCP adapters, Cursor, and VS Code Copilot Chat need version-specific configuration and live verification. No supported/unsupported verdict is inferred from the presence or absence of a setting in this review. This supersedes the 2026-08-31 configuration-only support labels.

## Acceptance procedure

1. Record client version and transport; use Streamable HTTP for Qujing.
2. Configure tool execution for at least 135 seconds and check for shorter idle limits.
3. Test the client against a separate controlled MCP server. For example, set a 150-second client timeout and verify a tool returning after 140 seconds. Do not use a real Qujing `ask` for this delay: its Runtime deadline is 120 seconds.
4. Test cancellation separately, verifying downstream settlement or connection closure and a subsequent new call. Never automatically replay an accepted `ask`.
5. Run the Qujing deployment checks in the setup Skill. A delayed-tool probe alone does not verify routing, authentication, Runtime history, or recovery.

Repeat acceptance after client upgrades. None of the above source checks replaces observed client behavior.
