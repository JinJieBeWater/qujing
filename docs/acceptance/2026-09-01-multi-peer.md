# Multi-Peer native acceptance — 2026-09-01

Release topology validated with one macOS Apple Silicon Agent, one macOS Apple Silicon Node, and one Omarchy Linux x64 Node.

## Checks

- Agent MCP tool surface: exactly `list_peers` and `ask`.
- Two Peers listed in configured order with verified Node and Workspace metadata.
- Each ask reached selected Node Workspace and returned its unique marker.
- Same-Peer follow-up retained remote Runtime history.
- Runtime restored same-session context after its process restarted.
- A real Runtime tool call generated a random 24-hex marker, and TanStack transcript state confirmed tool use.
- Agent cancellation reached selected Peer; later ask succeeded.
- Agent and Linux Node restart preserved both Peers' histories.
- Stopping Linux Node left macOS Peer available and Linux Peer unavailable without failing `list_peers`.
- Temporary credentials, state, Workspaces, and processes removed after run.

## Evidence

```json
{"tools":["list_peers","ask"],"peers":[{"id":"mac-peer","node":"mac-node","available":true,"workspaces":["facts"]},{"id":"linux-peer","node":"linux-node","available":true,"workspaces":["facts"]}],"mac":true,"linux":true,"followup":true,"cancellationObserved":true,"postCancellation":true}
{"tools":["list_peers","ask"],"peerCount":2,"allAvailable":true,"macHistory":true,"linuxHistory":true}
{"macAvailable":true,"linuxAvailable":false,"peerCount":2}
```

Also passed `bun run verify`, `bun run build:release all`, and `bun run test:transport:e2e` before this run.
