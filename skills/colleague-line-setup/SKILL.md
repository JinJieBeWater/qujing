---
name: colleague-line-setup
description: "Install, pair, configure, verify, operate, or troubleshoot Colleague Line Owner Gateways, Agent Client, private Lines, services, and MCP Agent access. Not product development."
compatibility: "Colleague Line release bundle; macOS arm64 or Linux x64 supported, Windows x64 Preview; Owner global Pi CLI required."
metadata:
  version: 2.0.0
  category: setup
  tags: [colleague-line, mcp, tailcat, pi]
---

# Colleague Line Setup

## Model

- **Owner**: real colleague. Runs Gateway, Pi Runtime, and manually registered Workspaces.
- **Client**: one local service on Agent machine. Owns one local MCP endpoint and many private Lines.
- **Line**: one Client-to-Owner pairing with distinct Tailcat key, remote Gateway Client ID, and remote bearer.
- **Agent**: MCP caller. Configures Client once, then explicitly chooses Line and Workspace.

One person may operate both roles. Keep role commands and credentials separate. One Client serves one Agent and can reach many Owners; never create per-Owner Agent MCP entries.

## Procedure

### 1. Select operation

Collect only inputs needed for branch:

- install, Owner setup, Client setup, pair Line, verify, rotate/revoke, upgrade, or recover
- OS/architecture and release-bundle path
- Owner ID/name and Workspace metadata
- Client local port; default `43111`
- local Line ID and remote Gateway Client ID

Treat local bearer, remote bearer, Tailcat private keys, server address, and Workspace roots as private. Ask humans to transfer remote bearer and Tailcat address through trusted channel; redact them from output.

### 2. Install matched release

Require both Colleague Line binaries from same release and platform:

```bash
install -d "$HOME/.local/bin"
install -m 0755 ./coll ./colleague-line-transport "$HOME/.local/bin/"
export PATH="$HOME/.local/bin:$PATH"
coll --help
```

Windows PowerShell Preview:

```powershell
New-Item -ItemType Directory -Force "$HOME\.local\bin" | Out-Null
Copy-Item .\coll.exe, .\colleague-line-transport.exe "$HOME\.local\bin\"
& "$HOME\.local\bin\coll.exe" --help
```

Stop on platform mismatch, missing transport binary, or unavailable Owner `pi` CLI. Do not invent download URLs or build from source unless requested. Windows Preview supports foreground `gateway serve` and `client serve` only; user-service install/remove is unsupported.

### 3. Configure Owner Gateway

Owner needs a working global Pi. Client machine does not. Run normal interactive `pi`, confirm its default model and authentication work, then exit. Gateway will use that same global Pi environment without overrides.

Initialize Owner once and register each Workspace manually:

```bash
coll init gateway \
  --owner-id <owner-id> \
  --owner-name <owner-name>

coll workspace add <workspace-id> \
  --name <display-name> \
  --root <workspace-directory> \
  --summary <responsibility-summary>

coll workspace list --json
coll doctor gateway
```

Use summaries that let Agent choose Workspace without exposing roots. Choose one startup mode:

- Foreground: hand off `coll serve gateway` in a separate terminal; wait for `gateway: ready` and keep it running.
- Service (macOS/Linux only):

```bash
coll service install gateway --yes
```

Do not start both modes.

Completion: Gateway doctor succeeds and Gateway is running.

### 4. Initialize Agent Client once

Run on Agent machine:

```bash
coll init client
coll doctor client
```

Capture `local-bearer` once into Agent’s private MCP configuration. Configure exactly one endpoint using [`references/mcp-clients.md`](references/mcp-clients.md).

Choose one Client startup mode:

- Foreground: hand off `coll serve client` in a separate terminal; wait for `client: ready` and keep it running.
- Service (macOS/Linux only):

```bash
coll service install client --yes
```

Do not start both modes.

Completion: Client is running and Agent sees exactly `list_lines` and `ask`. Empty `list_lines` is valid before pairing.

### 5. Pair one Line

On Client machine, generate distinct key:

```bash
coll line key-create <line-id>
```

Send only printed `public-key` to Owner. Keep key path on Client.

With Gateway still running on Owner machine, create remote Gateway Client identity for exactly this Line:

```bash
coll pair create <remote-client-id> \
  --key '<public-key>' \
  --out ./<remote-client-id>.pairing.json
```

The private pairing bundle contains:

- expected Owner ID
- remote Gateway Client ID
- remote bearer
- Tailcat server address
- remote port

Send the bundle to Client through trusted channel while preserving current-user-only permissions. On Client machine:

```bash
coll pair accept <line-id> \
  --from ./<remote-client-id>.pairing.json

rm ./<remote-client-id>.pairing.json

coll line list --json
coll doctor client
```

`pair create` publishes the bundle only after live reload applies the new credentials. `pair accept` derives the standard key path from Line ID. Pass `--key <private-key-path>` only when `key-create --output` used a custom path. It connects and verifies exact Owner ID before persistence; Owner mismatch must leave no Line. Omit `--out` to emit JSON on stdout and use `--from -` to import from stdin. Remove every transferred bundle copy after import. Repeat this step for additional Owners; keep same Client endpoint and local bearer.

### 6. Verify end to end

Require all:

1. `coll doctor gateway` succeeds on each Owner; `coll doctor client` succeeds on Agent machine.
2. Agent discovers exactly `list_lines` and `ask`.
3. `list_lines` includes every configured Line in local order. One unavailable Line does not hide healthy Lines.
4. Each available Line returns expected Owner and public Workspace metadata, without roots, credentials, Runtime, model, session, or Tailcat details.
5. `ask({ line, workspace, question })` answers from exact selected Owner Workspace.
6. Follow-up with same Line and Workspace retains that remote Runtime Session history.
7. Two Lines reach two different Owners without credential or answer crossover.
8. Cancel active ask; cancellation reaches selected Gateway only.
9. Restart one Owner Gateway and Client process/service; next ask reconnects without retrying prior accepted prompt.

TCP connectivity alone is insufficient.

### 7. Daily operation

```bash
# Owner
coll workspace list --json
coll doctor gateway

# Agent machine
coll line list --json
coll doctor client
```

Agent calls `list_lines`, chooses exact Line and Workspace IDs, then calls `ask`. Client starts Connectors lazily; no per-Line foreground process or MCP config exists.

### 8. Rotate or revoke

Remote credential rotation preserves Owner Runtime history:

1. Client creates new key at new path:

```bash
coll line key-create <line-id> --output <new-private-key-path>
```

2. Send new public key to Owner.
3. Owner rotates remote credentials:

```bash
coll pair rotate <remote-client-id> --key '<new-public-key>' --yes
```

4. Transfer new remote bearer to Client.
5. Client verifies and atomically replaces Line key/bearer:

```bash
printf '%s' '<new-remote-bearer>' | coll line update <line-id> \
  --key <new-private-key-path> \
  --bearer - \
  --yes
```

Revoke Owner access first, then remove local Line:

```bash
# Owner
coll pair revoke <remote-client-id> --yes

# Client
coll line remove <line-id> --yes
```

Rotate Agent-local bearer independently:

```bash
coll token rotate
```

Update Agent MCP secret immediately. Old local bearer and existing MCP sessions become invalid.

### 9. Upgrade

On macOS/Linux, stop/remove only installed role services on machine being upgraded:

```bash
coll service remove gateway --yes
coll service remove client --yes
```

Replace both Colleague Line binaries from same release, then reinstall required role services:

```bash
coll service install gateway --yes
coll service install client --yes
```

On Windows Preview, stop foreground role processes, replace both `.exe` files, then restart required `serve` commands; do not call `service install/remove`.

Run both doctors and repeat end-to-end verification. A machine running one role executes only that role’s commands.

## Recovery

- `UNAUTHORIZED`: distinguish Agent local bearer from Line remote bearer. Rotate correct layer; never redisplay stored secrets.
- `LINE_NOT_FOUND`: Client checks `coll line list --json`.
- `LINE_UNAVAILABLE`: Client checks Line key privacy, Tailcat path, Owner Gateway, remote bearer, and expected Owner ID.
- `OWNER_ID_MISMATCH`: verify handoff reached intended Owner; do not bypass check.
- `WORKSPACE_NOT_FOUND` / `WORKSPACE_UNAVAILABLE`: Owner checks `coll workspace list --json` and root.
- `RUNTIME_UNAVAILABLE`: Owner runs normal global `pi`, fixes its default model/auth/extensions, then restarts Gateway.
- `RUNTIME_TIMEOUT`: keep Agent timeout at least 135 seconds; inspect Owner model/network before manual retry.
- `BUSY`: wait for selected request/capacity to settle. Do not add automatic ask retry.
- Client startup failure: check `coll doctor client`, private `0600/0700` state, local port, and matched transport binary.
- Tailcat failure: check public-key allowlist, distinct per-Line private key, Gateway availability, and outbound network. Do not alter personal Tailscale routes or DNS.

## Report

Return:

- selected operation and machine role
- commands completed
- remaining human-only handoffs
- single Client MCP URL without bearer
- Line IDs and availability without private details
- verification results
- next exact command when blocked

Redact all bearers, private keys, Tailcat addresses, Workspace roots, questions, answers, and file contents.
