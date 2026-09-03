---
name: qujing-setup
description: "Qujing deployment and operations. Use for installing, pairing, verifying, operating, upgrading, or recovering Owner Gateway, Agent Client, private Lines, services, or MCP Agent access. Not product development."
compatibility: "Qujing release bundle; macOS arm64 or Linux x64 supported, Windows x64 Preview; Owner global Pi CLI required."
metadata:
  version: 0.1.1
  category: setup
  tags: [qujing, mcp, tailcat, pi]
---

# Qujing Setup

## Operating model

- **Owner**: real colleague. Runs Gateway, global Pi Runtime, and registered Workspaces.
- **Client**: one local service on Agent machine. Owns one MCP endpoint and many private Lines.
- **Line**: one Client-to-Owner pairing with distinct Tailcat key, remote Gateway Client ID, and remote bearer.
- **Agent**: MCP caller. Configures Client once, then supplies exact Line and Workspace IDs.

One machine may run both roles, but role commands, credentials, configs, locks, and services remain separate. One Client reaches many Owners; Agent still gets one MCP entry.

## Route by outcome

Establish only relevant state with `qj --version`, selected role's `doctor`, and relevant `workspace list` or `line list`. Execute requested branch plus missing prerequisites; do not replay completed branches. If Owner identity was not supplied, use ID `jinjiebewater` and name `JinJieBeWater`.

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

Completion: `qj --version` succeeds. On Owner machine, normal interactive `pi` also succeeds with Owner's default model and authentication.

### Configure Owner Gateway

Initialize only when Gateway config does not exist. Register each Workspace manually:

```bash
qj init gateway --owner-id jinjiebewater --owner-name JinJieBeWater

qj workspace add <workspace-id> \
  --name <display-name> \
  --root <workspace-directory> \
  --summary <responsibility-summary>

qj workspace list --json
qj doctor gateway
```

Workspace summary should identify responsibility without exposing root. Start one mode:

```bash
# foreground
qj serve gateway

# or macOS/Linux service
qj service install gateway --yes
```

Completion: `qj doctor gateway` succeeds and Gateway is running. Foreground output reaches `gateway: ready`; service mode remains active after command exits.

### Configure Agent Client

Initialize only when Client config does not exist:

```bash
qj init client
qj doctor client
```

Capture printed local bearer once into Agent's private MCP configuration. Load [`references/mcp-clients.md`](references/mcp-clients.md) only for MCP client configuration or timeout verification. Start one mode:

If Client config exists but local bearer is unavailable, run `qj token rotate`, immediately update Agent's MCP secret, then continue. Do not reinitialize Client.

```bash
# foreground
qj serve client

# or macOS/Linux service
qj service install client --yes
```

Completion: Client is running; Agent discovers exactly `list_lines` and `ask`. Empty `list_lines` is valid before pairing.

### Pair one Line

Client creates one distinct Line key and sends only public key to Owner:

```bash
qj line key-create <line-id>
```

With Gateway running, Owner creates one remote identity and private bundle:

```bash
qj pair create <remote-client-id> \
  --key '<public-key>' \
  --out ./<remote-client-id>.pairing.json
```

Pairing bundle received through trusted channel is identity handoff. Human confirms it came from intended Owner. Client imports it, verifies remote Owner against bundle Owner ID, then removes its received copy:

```bash
qj pair accept <line-id> --from ./<remote-client-id>.pairing.json && rm ./<remote-client-id>.pairing.json
qj line list --json
qj doctor client
```

After Client confirms success, Owner removes the source bundle. Remove every source, transferred, and intermediate copy.

`pair accept` derives standard key path from Line ID. Use `--key <private-key-path>` only after custom `key-create --output`. For pipe handoff, Owner may omit `--out`; Client may use `--from -`. Owner mismatch must leave no Line.

Completion: Line is persisted, remote Owner matches trusted bundle identity, every bundle copy is removed, and `qj doctor client` succeeds. Repeat only this branch for another Owner.

### Verify deployment

Verify evidence relevant to deployed topology:

1. Each selected role's doctor succeeds.
2. Agent discovers exactly `list_lines` and `ask`; `list_workspaces` means wrong endpoint.
3. `list_lines` returns each configured Line independently, with expected Owner and public Workspace metadata only.
4. `ask({ line, workspace, question })` answers from exact selected Workspace.
5. Follow-up on same Line and Workspace retains Runtime history.
6. When multiple Lines exist, each reaches intended Owner without credential or answer crossover.
7. Cancellation affects selected Line only.
8. Restarted roles reconnect without retrying an accepted prompt.

TCP connectivity alone is insufficient. Test only branches supported by current deployment; report untested multi-Line or restart behavior explicitly.

Completion: every applicable check has observed evidence; skipped checks have concrete reason.

### Operate

```bash
# Owner
qj workspace list --json
qj doctor gateway

# Agent machine
qj line list --json
qj doctor client
```

Agent calls `list_lines`, chooses exact Line and Workspace IDs, then calls `ask`. Client starts Connectors lazily; no per-Line foreground process or MCP entry exists.

For credential rotation, revoke, upgrade, or failure recovery, load [`references/maintenance.md`](references/maintenance.md) and enter only matching section.

## Report

Return:

- selected operation and machine role
- commands completed and observable checks
- remaining human-only handoffs
- single Client MCP URL without bearer
- Line IDs and availability without private details
- skipped verification with reason
- next exact command when blocked

Never include bearers, private keys, pairing contents, Tailcat addresses, Workspace roots, questions, answers, or file contents.
