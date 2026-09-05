---
name: qujing-setup
description: "Qujing deployment and operations. Use for installing, pairing, verifying, operating, upgrading, or recovering Node, Agent, private Peers, services, or MCP Agent access. Not product development."
compatibility: "Qujing release bundle; macOS arm64 or Linux x64 supported, Windows x64 Preview; ACP-compatible Runtime command required."
metadata:
  version: 0.1.2
  category: setup
  tags: [qujing, mcp, tailcat, pi]
---

# Qujing Setup

## Operating model

- **Node**: real colleague. Runs Node, configured TanStack ACP Runtime, and registered Workspaces.
- **Agent service**: local MCP service on the Agent machine. Owns one MCP endpoint and many private Peers.
- **Peer**: one Agent-service-to-Node pairing with distinct Tailcat key, remote Peer credential ID, and remote bearer.
- **Agent**: MCP caller. Configures the Agent service once, then supplies exact Peer and Workspace IDs.

One machine may run both roles, but role commands, credentials, configs, locks, and services remain separate. One Agent reaches many Nodes; Agent still gets one MCP entry.

## Route by outcome

Establish only relevant state with `qj --version`, selected role's `doctor`, and relevant `workspace list` or `peer list`. Execute requested branch plus missing prerequisites; do not replay completed branches. If Node identity was not supplied, use ID `jinjiebewater` and name `JinJieBeWater`.

Treat local bearer, remote bearer, Tailcat private keys, pairing bundles, server addresses, and Workspace roots as private. Keep secrets in current-user-only files or secret storage. Human performs cross-machine secret transfer through trusted channel. Redact secrets from commands echoed back and final report.

### Install

macOS Apple Silicon or Linux x64, preferred Homebrew path:

```bash
brew tap jinjiebewater/tap
brew trust --formula jinjiebewater/tap/qujing
brew install qujing
qj --version
```

Fallback installer:

```bash
curl -fsSL https://raw.githubusercontent.com/JinJieBeWater/qujing/main/install.sh | sh
export PATH="${QUJING_INSTALL_DIR:-$HOME/.local/bin}:$PATH"
qj --version
```

Windows x64 Preview:

```powershell
irm https://raw.githubusercontent.com/JinJieBeWater/qujing/main/install.ps1 | iex
$installDir = if ($env:QUJING_INSTALL_DIR) { $env:QUJING_INSTALL_DIR } else { "$HOME\.local\bin" }
$env:Path = "$installDir;$env:Path"
qj --version
```

Use `QUJING_VERSION=v<version>` for a pinned standalone install and `QUJING_INSTALL_DIR` when `~/.local/bin` is unsuitable. Review piped installers first when local policy requires it. Stop on checksum failure, unsupported platform, or mismatched/missing `qj` and `qujing-transport`.

Completion: `qj --version` succeeds. On Node machine, configured ACP-compatible Runtime command exists on `PATH`.

### Configure Node

Initialize only when Node config does not exist. Register each Workspace manually:

```bash
qj init node --node-id jinjiebewater --node-name JinJieBeWater

qj workspace add <workspace-id> \
  --name <display-name> \
  --root <workspace-directory> \
  --summary <responsibility-summary>

qj workspace list --json
qj runtime set-pi --model openai-codex/gpt-5.5
qj doctor node
```

Workspace summary should identify responsibility without exposing root. Start one mode:

```bash
# foreground
qj serve node

# or macOS/Linux service
qj service install node --yes
```

Completion: `qj doctor node` succeeds and Node is running. Foreground output reaches `node: ready`; service mode remains active after command exits.

### Configure Agent

Initialize only when Agent config does not exist:

```bash
qj init agent
qj doctor agent
```

Capture printed local bearer once into Agent's private MCP configuration. Load [`references/mcp-agents.md`](references/mcp-agents.md) only for MCP agent configuration or timeout verification. Start one mode:

If Agent config exists but local bearer is unavailable, run `qj token rotate`, immediately update Agent's MCP secret, then continue. Do not reinitialize Agent.

```bash
# foreground
qj serve agent

# or macOS/Linux service
qj service install agent --yes
```

Completion: Agent is running; Agent discovers exactly `list_peers` and `ask`. Empty `list_peers` is valid before pairing.

### Pair one Peer

Agent creates one distinct Peer key and sends only public key to Node:

```bash
qj peer key-create <peer-id>
```

With Node running, Node creates one remote Peer credential and private bundle:

```bash
qj peer invite <remote-peer-credential-id> \
  --key '<public-key>' \
  --out ./<remote-peer-credential-id>.pairing.json
```

Pairing bundle received through trusted channel is identity handoff. Human confirms it came from intended Node. Agent imports it, verifies remote Node against bundle Node ID, then removes its received copy:

```bash
qj peer accept <peer-id> --from ./<remote-peer-credential-id>.pairing.json && rm ./<remote-peer-credential-id>.pairing.json
qj peer list --json
qj doctor agent
```

After Agent confirms success, Node removes the source bundle. Remove every source, transferred, and intermediate copy.

`peer accept` derives standard key path from Peer ID. Use `--key <private-key-path>` only after custom `key-create --output`. For pipe handoff, Node may omit `--out`; Agent may use `--from -`. Node mismatch must leave no Peer.

Completion: Peer is persisted, remote Node matches trusted bundle identity, every bundle copy is removed, and `qj doctor agent` succeeds. Repeat only this branch for another Node.

### Verify deployment

Verify evidence relevant to deployed topology:

1. Each selected role's doctor succeeds.
2. Agent discovers exactly `list_peers` and `ask`; `list_workspaces` means wrong endpoint.
3. `list_peers` returns each configured Peer independently, with expected Node and public Workspace metadata only.
4. `ask({ peer, workspace, question })` answers from exact selected Workspace.
5. Follow-up on same Peer and Workspace retains Runtime history.
6. When multiple Peers exist, each reaches intended Node without credential or answer crossover.
7. Cancellation affects selected Peer only.
8. Restarted roles reconnect without retrying an accepted prompt.

TCP connectivity alone is insufficient. Test only branches supported by current deployment; report untested multi-Peer or restart behavior explicitly.

Completion: every applicable check has observed evidence; skipped checks have concrete reason.

### Operate

```bash
# Node
qj workspace list --json
qj runtime set-pi --model openai-codex/gpt-5.5
qj doctor node

# Agent machine
qj peer list --json
qj doctor agent
```

Agent calls `list_peers`, chooses exact Peer and Workspace IDs, then calls `ask`. Agent starts Connectors lazily; no per-Peer foreground process or MCP entry exists.

For credential rotation, revoke, upgrade, or failure recovery, load [`references/maintenance.md`](references/maintenance.md) and enter only matching section.

## Report

Return:

- selected operation and machine role
- commands completed and observable checks
- remaining human-only handoffs
- single Agent MCP URL without bearer
- Peer IDs and availability without private details
- skipped verification with reason
- next exact command when blocked

Never include bearers, private keys, pairing contents, Tailcat addresses, Workspace roots, questions, answers, or file contents.
