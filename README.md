# Qujing

**English** | [简体中文](README.zh-CN.md)

Qujing lets one MCP Agent ask multiple real colleagues through one local Node endpoint. Each colleague is a Qujing Node with manually registered Workspaces. Local Node keeps one private **Peer Link** per paired Peer and routes only when Agent supplies exact Peer and Workspace IDs.

```text
Agent → local Node MCP → selected Peer Link/Tailcat → Peer Node → Runtime → Workspace
```

No automatic routing, shared knowledge index, public Node, network discovery, or per-Peer Agent MCP configuration.

> **Platforms:** macOS Apple Silicon and Linux x64 supported. Windows x64 release remains **Preview** pending native acceptance.

## Agent-facing MCP

Local Node exposes exactly two Streamable HTTP tools at `/mcp`:

- `list_peers()` returns visible Peer candidates plus each paired Peer’s availability, verified Node metadata, and public Workspace metadata.
- `ask({ peer, workspace, question })` asks one exact Workspace through one exact Peer.

Agent authenticates with one local bearer. Agent is not a Peer. Discovery is only visibility; `ask` still requires paired Peer credentials. Set MCP tool-call timeout to at least **135 seconds**. Node’s internal `list_workspaces()` and `ask({ workspace, question })` are never configured directly in Agent.

## Model

- **Node** is one Qujing identity controlled by one person. One installation has one Node identity.
- **Peer** is another Qujing Node visible to local Node. Manual PeerDirectory can list candidates; empty directory lists none.
- **Agent** connects only to local Node at `http://127.0.0.1:43111/mcp` by default and is not part of Peer mesh.

One `qj serve` daemon hosts local MCP, Peer-facing MCP, Runtime, and Connector resources.

## Install

Upgrading from v0.1.x requires a stopped-service configuration migration, not only a binary upgrade. Read the [v0.2.0 upgrade notes](docs/releases/v0.2.0.md) before replacing the installed version.

macOS Apple Silicon or Linux x64:

```bash
brew tap jinjiebewater/tap
brew trust --formula jinjiebewater/tap/qujing
brew install qujing
qj --version
```

Homebrew 6 requires the formula-specific trust step for third-party taps. To use the standalone installer instead:

```bash
curl -fsSL https://raw.githubusercontent.com/JinJieBeWater/qujing/main/install.sh | sh
export PATH="${QUJING_INSTALL_DIR:-$HOME/.local/bin}:$PATH"
qj --version
```

The installer downloads and verifies the matching GitHub Release, then installs both executables to `~/.local/bin`. Set `QUJING_INSTALL_DIR` to choose another directory. Pin a release with:

```bash
curl -fsSL https://raw.githubusercontent.com/JinJieBeWater/qujing/main/install.sh | QUJING_VERSION=v0.2.0 sh
```

Windows x64 Preview:

```powershell
irm https://raw.githubusercontent.com/JinJieBeWater/qujing/main/install.ps1 | iex
$installDir = if ($env:QUJING_INSTALL_DIR) { $env:QUJING_INSTALL_DIR } else { "$HOME\.local\bin" }
$env:Path = "$installDir;$env:Path"
qj --version
```

Review [`install.sh`](install.sh) or [`install.ps1`](install.ps1) before execution when required by local security policy. Manual archives and `SHA256SUMS` remain available on [GitHub Releases](https://github.com/JinJieBeWater/qujing/releases).

### Agent-assisted setup

Install Qujing binaries above, then give your coding Agent the repository's operational skill:

```bash
bunx --bun skills add "JinJieBeWater/qujing@v$(qj --version)" --skill qujing-setup --global --yes
```

For a version-pinned or offline release bundle, run `bunx --bun skills add ./skills/qujing-setup --global --yes` from its extracted directory instead. Ask: `Use qujing-setup to deploy, pair, or diagnose Qujing.` The skill selects only the branch needed, verifies observable state, and keeps secrets out of its report. Product development agents should use [`AGENTS.md`](AGENTS.md) instead.

## Minimal setup

Both installation methods keep `qj` and `qujing-transport` from the same release together. Node Runtime is either built-in Pi RPC or a configured TanStack AI ACP harness.

Pi RPC requires a Pi CLI with `clear_queue` and `agent_settled` support; Pi 0.85.1 is verified. Pi 0.84.3 lacks `clear_queue` and cannot satisfy Qujing's cancellation contract. Keep the owner's Pi settings, authentication, extensions, and session archive when upgrading.

### 1. Initialize Node

```bash
qj init --node-id jinjiebewater --node-name JinJieBeWater
qj workspace add runtime-tooling --name "Runtime Tooling" --root ~/src/runtime --summary "Runtime SDK and extensions"
```

Configure Runtime before starting Node:

```bash
qj runtime set-pi --model openai-codex/gpt-5.5
```

`qj init` prints local bearer once. Configure Agent once:

- URL: `http://127.0.0.1:43111/mcp`
- Header: `Authorization: Bearer <local-bearer>`
- Timeout: at least `135` seconds

If local bearer was lost, run `qj token rotate` and replace Agent's stored bearer.

In separate terminal, run and leave Qujing active:

```bash
qj serve
```

### 2. Pair one Peer

On local Node machine, create Peer Link key:

```bash
qj peer key-create jinjiebewater
```

Send printed public key to Peer Node. With Node still running, Peer Node registers one remote Peer credential:

```bash
qj peer invite alice-jinjiebewater \
  --key 'nodekey:...' \
  --out ./alice-jinjiebewater.pairing.json
```

Transfer the private pairing bundle to local Node through a trusted channel. Local Node imports it, uses the key created for `jinjiebewater` by default, verifies Peer Node, and saves Peer Link:

```bash
qj peer accept jinjiebewater --from ./alice-jinjiebewater.pairing.json && rm ./alice-jinjiebewater.pairing.json
```

After local Node confirms import, Peer Node also removes its source `alice-jinjiebewater.pairing.json`. The bundle contains one-time remote bearer and Tailcat coordinates. Keep it private and remove every source, transferred, and intermediate copy after import. Omit `--out` to emit JSON on stdout; use `--from -` to import from stdin.

Repeat only step 3 for more Peers. Agent endpoint and local bearer stay unchanged.

For agent-run installation, pairing, verification, credential rotation, upgrades, or recovery, use [`skills/qujing-setup/SKILL.md`](skills/qujing-setup/SKILL.md).

## Trust model

- Node MCP, Agent-facing MCP, and ephemeral Connectors bind loopback only; Tailcat forwards only Node port.
- Agent local bearer and every Peer Link’s Tailcat key/remote bearer are distinct.
- Local Node verifies expected Peer Node ID on every rebuilt upstream MCP session.
- Node Runtime can run built-in Pi RPC with explicit `provider/model`, or any ACP-compatible CLI through `@tanstack/ai`, `@tanstack/ai-acp`, local process sandbox, TanStack persistence, and TanStack locks.
- Qujing appends a fixed consultation prompt that asks Runtime to gather relevant context and behave read-only. It does not replace or filter Runtime configuration; the prompt is behavior guidance, not a security boundary.
- Every paired Peer is therefore trusted with Node-level Runtime capability, including shell execution, file changes, and access outside selected Workspace when Runtime chooses it.
- Runtime Session IDs remain distinct by remote Peer credential and Workspace. Revocation removes binding but does not delete TanStack transcript state unless removed separately.
- Default Qujing logs exclude credentials, addresses, roots, questions, answers, and file contents.

## Operations

```bash
qj doctor

qj service install --yes
```

Process service uses one launchd/systemd unit on macOS/Linux. macOS Background Items identify it as `qujing-daemon`; terminal command remains `qj`. Windows Preview is foreground-only. Run `qj serve` in foreground while diagnosing.

## Source checkout

Release builds require Bun, Go, and `tar`; Windows archives also require `zip`. Missing tools fail before `dist` is changed. Transport E2E requires Bash, Python 3, and curl.

```bash
bun run verify
bun run test:transport:e2e
bun run build:release all
```

Tailcat uses official best-effort DERP by default. Add private DERP only after measured need.
