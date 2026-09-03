# Qujing

**English** | [简体中文](README.zh-CN.md)

Qujing lets one MCP Agent ask multiple real colleagues through one local endpoint. Each colleague runs an Owner Gateway over manually registered Workspaces. Agent-side Client keeps one private **Line** per Owner and routes only when Agent supplies exact Line and Workspace IDs.

```text
Agent → local Client MCP → selected Line/Tailcat → Owner Gateway → Pi → Workspace
```

No automatic routing, shared knowledge index, public Gateway, or per-Owner Agent MCP configuration.

> **Platforms:** macOS Apple Silicon and Linux x64 supported. Windows x64 release remains **Preview** pending native acceptance.

## Agent-facing MCP

Client exposes exactly two Streamable HTTP tools at `/mcp`:

- `list_lines()` returns each Line’s availability, verified Owner metadata, and public Workspace metadata.
- `ask({ line, workspace, question })` asks one exact Workspace through one exact Line.

Agent authenticates with one local bearer. Set MCP tool-call timeout to at least **135 seconds**. Owner Gateway’s internal `list_workspaces()` and `ask({ workspace, question })` are never configured directly in Agent.

## Roles

- **Owner** runs Gateway, Pi Runtime, and Workspaces.
- **Client** runs one local MCP service and private Lines to any number of Owners.
- **Agent** connects only to Client at `http://127.0.0.1:43111/mcp` by default.

One machine may run both Owner and Client roles. Their commands, configs, locks, and services remain separate.

## Install

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
curl -fsSL https://raw.githubusercontent.com/JinJieBeWater/qujing/main/install.sh | QUJING_VERSION=v0.1.1 sh
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

Both installation methods keep `qj` and `qujing-transport` from the same release together. Owner machine must also have its normal global `pi` CLI available on `PATH`.

### 1. Start Owner Gateway

```bash
qj init gateway --owner-id jinjiebewater --owner-name JinJieBeWater
qj workspace add pi-tooling --name "Pi Tooling" --root ~/src/pi --summary "Pi SDK and extensions"
```

In separate Owner terminal, run and leave Gateway active:

```bash
qj serve gateway
```

### 2. Initialize Agent Client once

```bash
qj init client
```

In separate Client terminal, run and leave Client active:

```bash
qj serve client
```

`qj init client` prints local bearer once. Configure Agent once:

- URL: `http://127.0.0.1:43111/mcp`
- Header: `Authorization: Bearer <local-bearer>`
- Timeout: at least `135` seconds

If Client was already initialized but its local bearer was lost, run `qj token rotate` and replace Agent's stored bearer.

### 3. Pair one Line

On Client machine, create Line key:

```bash
qj line key-create jinjiebewater
```

Send printed public key to Owner. With Gateway still running, Owner registers one remote Gateway Client identity:

```bash
qj pair create alice-jinjiebewater \
  --key 'nodekey:...' \
  --out ./alice-jinjiebewater.pairing.json
```

Transfer the private pairing bundle to Client through a trusted channel. Client imports it, uses the key created for `jinjiebewater` by default, verifies Owner, and saves Line:

```bash
qj pair accept jinjiebewater --from ./alice-jinjiebewater.pairing.json && rm ./alice-jinjiebewater.pairing.json
```

After Client confirms import, Owner also removes its source `alice-jinjiebewater.pairing.json`. The bundle contains the one-time remote bearer and Tailcat coordinates. Keep it private and remove every source, transferred, and intermediate copy after import. Omit `--out` to emit JSON on stdout; use `--from -` to import from stdin.

Repeat only step 3 for more Owners. Agent endpoint and local bearer stay unchanged.

For agent-run installation, pairing, verification, credential rotation, upgrades, or recovery, use [`skills/qujing-setup/SKILL.md`](skills/qujing-setup/SKILL.md).

## Trust model

- Gateway, Client, and ephemeral Connectors bind loopback only; Tailcat forwards only Gateway port.
- Agent local bearer and every Line’s Tailcat key/remote bearer are distinct.
- Client verifies expected Owner ID on every rebuilt upstream MCP session.
- Gateway runs Owner’s full global `pi --mode rpc --approve`: default model, authentication, settings, skills, extensions, builtin tools, and `~/.pi/agent/sessions/`.
- Qujing appends a fixed consultation prompt that asks Pi to gather relevant context and behave read-only. It does not replace or filter Owner's Pi configuration; the prompt is behavior guidance, not a security boundary.
- Every paired remote Gateway Client is therefore trusted with Owner-level Pi capability, including shell execution, file changes, and access outside selected Workspace when Pi chooses it.
- Runtime Session IDs remain distinct by remote Gateway Client and Workspace. Revocation removes binding but does not delete Owner’s global Pi archive.
- Default Qujing logs exclude credentials, addresses, roots, questions, answers, and file contents.

## Operations

```bash
qj doctor gateway
qj doctor client

qj service install gateway --yes
qj service install client --yes
```

Role services use separate launchd/systemd units on macOS/Linux; Windows Preview is foreground-only. Run `qj serve gateway` or `qj serve client` in foreground while diagnosing.

## Source checkout

```bash
bun run verify
bun run test:transport:e2e
bun run build:release all
```

Tailcat uses official best-effort DERP by default. Add private DERP only after measured need.
