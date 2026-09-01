# Multi-Line native acceptance — 2026-09-01

Release topology validated with one macOS Apple Silicon Client, one macOS Apple Silicon Owner Gateway, and one Omarchy Linux x64 Owner Gateway.

## Checks

- Client MCP tool surface: exactly `list_lines` and `ask`.
- Two Lines listed in configured order with verified Owner and Workspace metadata.
- Each ask reached selected Owner Workspace and returned its unique marker.
- Same-Line follow-up retained remote Runtime history.
- Agent cancellation reached selected Line; later ask succeeded.
- Client and Linux Gateway restart preserved both Lines' histories.
- Stopping Linux Gateway left macOS Line available and Linux Line unavailable without failing `list_lines`.
- Temporary credentials, state, Workspaces, and processes removed after run.

## Evidence

```json
{"tools":["list_lines","ask"],"lines":[{"id":"mac-line","owner":"mac-owner","available":true,"workspaces":["facts"]},{"id":"linux-line","owner":"linux-owner","available":true,"workspaces":["facts"]}],"mac":true,"linux":true,"followup":true,"cancellationObserved":true,"postCancellation":true}
{"tools":["list_lines","ask"],"lineCount":2,"allAvailable":true,"macHistory":true,"linuxHistory":true}
{"macAvailable":true,"linuxAvailable":false,"lineCount":2}
```

Also passed `bun run verify`, `bun run build:release all`, and `bun run test:transport:e2e` before this run.
