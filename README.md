# Colleague Line

**English** | [简体中文](README.zh-CN.md)

Colleague Line lets one MCP Agent ask multiple real colleagues through one local endpoint. Each colleague runs an Owner Gateway over manually registered Workspaces. Agent-side Client keeps one private **Line** per Owner and routes only when Agent supplies exact Line and Workspace IDs.

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

## Minimal setup

Keep `colleague-line` and `colleague-line-transport` from same release in one directory. Owner machine must also have its normal global `pi` CLI available on `PATH`.

### 1. Start Owner Gateway

```bash
colleague-line gateway init --owner-id jason --owner-name Jason
colleague-line gateway workspace add pi-tooling --name "Pi Tooling" --root ~/src/pi --summary "Pi SDK and extensions"
```

In separate Owner terminal, run and leave Gateway active:

```bash
colleague-line gateway serve
```

### 2. Initialize Agent Client once

```bash
colleague-line client init
```

In separate Client terminal, run and leave Client active:

```bash
colleague-line client serve
```

`colleague-line client init` prints local bearer once. Configure Agent once:

- URL: `http://127.0.0.1:43111/mcp`
- Header: `Authorization: Bearer <local-bearer>`
- Timeout: at least `135` seconds

### 3. Pair one Line

On Client machine, create Line key:

```bash
colleague-line client line key-create jason
```

Send printed public key to Owner. Owner registers one remote Client identity:

```bash
colleague-line gateway client add alice-jason --tailcat-key 'nodekey:...'
```

Owner command prints remote bearer once plus Tailcat address and port. Transfer those values through trusted channel. Then Client verifies Owner and saves Line:

```bash
printf '%s' '<remote-bearer>' | colleague-line client line add jason \
  --owner-id jason \
  --remote-client-id alice-jason \
  --server '<tailcat-address>' \
  --port 43110 \
  --key ~/.local/share/colleague-line/client/keys/jason.json \
  --bearer -
```

Repeat only step 3 for more Owners. Agent endpoint and local bearer stay unchanged.

Full install, pairing, rotation, revocation, service, and recovery workflow: [`skills/colleague-line-setup/SKILL.md`](skills/colleague-line-setup/SKILL.md).

## Trust model

- Gateway, Client, and ephemeral Connectors bind loopback only; Tailcat forwards only Gateway port.
- Agent local bearer and every Line’s Tailcat key/remote bearer are distinct.
- Client verifies expected Owner ID on every rebuilt upstream MCP session.
- Gateway runs Owner’s full global `pi --mode rpc --approve`: default model, authentication, settings, skills, extensions, builtin tools, and `~/.pi/agent/sessions/`.
- Every paired remote Client is therefore trusted with Owner-level Pi capability, including shell execution, file changes, and access outside selected Workspace when Pi chooses it.
- Runtime Session IDs remain distinct by remote Gateway Client and Workspace. Revocation removes binding but does not delete Owner’s global Pi archive.
- Default Colleague Line logs exclude credentials, addresses, roots, questions, answers, and file contents.

## Operations

```bash
colleague-line gateway doctor
colleague-line client doctor

colleague-line gateway service install --yes
colleague-line client service install --yes
```

Role services use separate launchd/systemd units on macOS/Linux; Windows Preview is foreground-only. Run `colleague-line gateway serve` or `colleague-line client serve` in foreground while diagnosing.

## Source checkout

```bash
bun run verify
bun run test:transport:e2e
bun run build:release all
```

Tailcat uses official best-effort DERP by default. Add private DERP only after measured need.
