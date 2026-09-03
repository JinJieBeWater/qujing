# Maintenance and recovery

Load only section matching requested operation or observed failure.

## Rotate one Line

Remote credential rotation preserves Owner Runtime history.

1. Client creates new key at a new path:

   ```bash
   qj line key-create <line-id> --output <new-private-key-path>
   ```

2. Human sends only new public key to Owner.
3. Owner invalidates old credentials and issues new bearer:

   ```bash
   qj pair rotate <remote-client-id> --key '<new-public-key>' --yes
   ```

4. Human transfers new remote bearer privately.
5. Client verifies and atomically replaces key and bearer:

   ```bash
   printf '%s' '<new-remote-bearer>' | qj line update <line-id> \
     --key <new-private-key-path> \
     --bearer - \
     --yes
   ```

Completion: old credentials fail, updated Line passes `qj doctor client`, same remote Client identity remains.

## Revoke one Line

Owner revokes access before Client removes local route:

```bash
# Owner
qj pair revoke <remote-client-id> --yes

# Client
qj line remove <line-id> --yes
```

Completion: remote identity no longer appears in Owner pairing list; local Line no longer appears in Client line list. Owner's Pi archive remains.

## Rotate Agent-local bearer

```bash
qj token rotate
```

Update Agent MCP secret immediately. Old local bearer and existing MCP sessions become invalid.

Completion: old bearer fails; new bearer lists Lines through same Client URL.

## Upgrade

Record every active role and whether it runs as a foreground process or service. Stop every foreground process and remove every installed service before replacing binaries. On macOS/Linux, run the removal once per installed service, then upgrade the package once:

```bash
qj service remove <each-installed-role> --yes
brew upgrade qujing
```

For standalone installation, replace both binaries together from one release instead of `brew upgrade`.

If `qujing-setup` is installed globally, replace it with the Skill from the new binary version:

```bash
bunx --bun skills add "JinJieBeWater/qujing@v$(qj --version)" --skill qujing-setup --global --yes
```

Restore every previously active role in its recorded mode only after package and Skill replacement:

```bash
qj service install <each-previously-installed-role> --yes

# In a separate terminal for each previously foreground role:
qj serve <each-previously-foreground-role>

qj doctor <each-active-role>
```

On Windows Preview, stop all foreground role processes, replace both `.exe` files once, update globally installed Skill with the same versioned command, then restart selected `qj serve <role>` commands. Service install/remove is unsupported.

Completion: `qj --version` reports the new version, installed Skill uses its matching Git tag, each foreground role reaches its ready message, and every restored role's doctor succeeds.

## Recover by symptom

- `UNAUTHORIZED`: distinguish Agent local bearer from Line remote bearer. Rotate correct layer; stored secrets cannot be redisplayed.
- `LINE_NOT_FOUND`: inspect `qj line list --json`.
- `LINE_UNAVAILABLE`: inspect Line key privacy, Tailcat path, Owner Gateway, remote bearer, and expected Owner ID.
- `OWNER_ID_MISMATCH`: verify handoff reached intended Owner. Preserve identity check.
- `WORKSPACE_NOT_FOUND` / `WORKSPACE_UNAVAILABLE`: Owner inspects `qj workspace list --json` and registered root.
- `RUNTIME_UNAVAILABLE`: Owner runs normal global `pi`, fixes default model/auth/extensions, then restarts Gateway.
- `RUNTIME_TIMEOUT`: keep Agent timeout at least 135 seconds; inspect Owner model/network before manual retry.
- `BUSY`: wait for selected request/capacity to settle. Do not automatically retry `ask`.
- Client startup failure: run `qj doctor client`; inspect private state permissions, local port, and matched transport binary.
- Tailcat failure: inspect public-key allowlist, distinct per-Line private key, Gateway availability, and outbound network. Leave personal Tailscale routes and DNS unchanged.

Completion: selected role's doctor succeeds and failed operation is re-run manually only when no accepted `ask` may be duplicated.
