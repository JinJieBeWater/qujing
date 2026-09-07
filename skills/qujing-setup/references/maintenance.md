# Maintenance and recovery

Load only section matching requested operation or observed failure.

## Rotate one Peer

Remote credential rotation preserves Node Runtime history.

1. Agent creates new key at a new path:

   ```bash
   qj peer key-create <peer-id> --output <new-private-key-path>
   ```

2. Human sends only new public key to Node.
3. Node invalidates old credentials and issues new bearer:

   ```bash
   qj peer rotate <remote-peer-credential-id> --key '<new-public-key>' --yes
   ```

4. Human transfers new remote bearer privately.
5. Agent verifies and atomically replaces key and bearer:

   ```bash
   printf '%s' '<new-remote-bearer>' | qj peer update <peer-id> \
     --key <new-private-key-path> \
     --bearer - \
     --yes
   ```

Completion: old credentials fail, updated Peer passes `qj doctor`, same remote Peer credential remains.

## Revoke one Peer

Node revokes access before Agent removes local route:

```bash
# Node
qj peer revoke <remote-peer-credential-id> --yes

# Agent
qj peer remove <peer-id> --yes
```

Completion: remote Peer credential is absent from Node pairing list; local Peer is absent from Agent peer list. Revocation retires active Runtime resources and removes Qujing bindings, but preserves backend-owned history: Pi sessions under the owner's Pi state, or TanStack transcript/run state under Node state.

## Rotate Agent-local bearer

```bash
qj token rotate
```

Update Agent MCP secret immediately. Old local bearer and existing MCP sessions become invalid.

Completion: old bearer fails; new bearer lists Peers through same Agent URL.

## Upgrade

Record whether Qujing runs as foreground process or service. Stop foreground process or remove installed service before replacing binaries. On macOS/Linux, remove service before upgrade:

```bash
qj service remove --yes
brew upgrade qujing
```

For standalone installation, replace both binaries together from one release instead of `brew upgrade`.

If `qujing-setup` is installed globally, replace it with the Skill from the new binary version:

```bash
bunx --bun skills add "JinJieBeWater/qujing@v$(qj --version)" --skill qujing-setup --global --yes
```

Restore previous foreground/service mode only after package and Skill replacement:

```bash
qj service install --yes

# In a separate terminal for previous foreground mode:
qj serve

qj doctor
```

On Windows Preview, stop foreground process, replace both `.exe` files once, update globally installed Skill with the same versioned command, then restart `qj serve`. Service install/remove is unsupported.

Completion: `qj --version` reports the new version, installed Skill uses its matching Git tag, foreground mode reaches `qujing: ready`, and `qj doctor` succeeds.

## Recover by symptom

- `UNAUTHORIZED`: distinguish Agent local bearer from Peer remote bearer. Rotate correct layer; stored secrets cannot be redisplayed.
- `PEER_NOT_FOUND`: inspect `qj peer list --json`.
- `PEER_UNAVAILABLE`: inspect Peer key privacy, Tailcat path, Node, remote bearer, and expected Node ID.
- `NODE_ID_MISMATCH`: verify handoff reached intended Node. Preserve identity check.
- `WORKSPACE_NOT_FOUND` / `WORKSPACE_UNAVAILABLE`: Node inspects `qj workspace list --json` and registered root.
- `RUNTIME_UNAVAILABLE`: run `qj doctor` on Node and inspect the configured backend. For Pi RPC, verify the configured Pi binary and explicit model in the owner's normal Pi authentication/extension environment. For TanStack ACP, verify the configured CLI command, model, and authentication mode. Restart the daemon after correcting the failure; do not switch backends or change global Pi defaults as a recovery shortcut.
- `RUNTIME_TIMEOUT`: keep Agent timeout at least 135 seconds; inspect Node model/network before manual retry.
- `BUSY`: wait for selected request/capacity to settle. Do not automatically retry `ask`.
- Daemon exits after cancellation: capture its exit code and the Runtime's RPC response. Pi's `Unknown command: clear_queue` means an incompatible Pi version, not a slow abort; upgrade to a compatible version with the owner's approval. Do not skip queue clearing or raise cancellation deadlines to hide it.
- Agent MCP startup failure: run `qj doctor`; inspect private state permissions, local port, and matched transport binary.
- Tailcat failure: inspect public-key allowlist, distinct per-Peer private key, Node availability, and outbound network. Leave personal Tailscale routes and DNS unchanged.

Completion: `qj doctor` succeeds and failed operation is re-run manually only when no accepted `ask` may be duplicated.
