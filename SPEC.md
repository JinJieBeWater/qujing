# Colleague Line specification

Status: Client multiplexing is verified on macOS Apple Silicon and Linux x64. Full global Pi Runtime replacement requires acceptance again. Windows x64 remains Preview.

## 1. Topology

One external Agent configures exactly one local Colleague Line Client MCP server. That Client manages multiple private Lines, each reaching a separate Owner Gateway. No central directory, automatic routing, shared history, compatibility layer for prior topology, or Agent-facing direct Gateway MCP connection exists.

```text
Agent
  | one local bearer
  v
Client MCP server ── private Line A ── Tailcat ── Owner A Gateway ── Runtime
                  └─ private Line B ── Tailcat ── Owner B Gateway ── Runtime
```

One Gateway represents one Owner and manages Owner Workspaces. Runtime is implementation, never person or public identity.

## 2. Contracts

### Agent-facing Client MCP

Client exposes exactly:

```ts
list_lines(): {
  lines: Array<{
    id: string;
    available: boolean;
    owner?: { id: string; name: string; summary?: string };
    workspaces: Array<{
      id: string;
      name: string;
      summary: string;
      available: boolean;
    }>;
  }>;
}

ask(input: { line: string; workspace: string; question: string }): {
  line: string;
  workspace: string;
  answer: string;
}
```

`list_lines()` queries every configured Line independently and returns each verified Owner with that Gateway's public Workspaces. It never flattens Workspaces across Owners. An unreachable, unauthorized, or identity-mismatched Line remains in the result with `available: false`, no `owner`, and an empty `workspaces`; one failed Line cannot fail the whole result.

`line` must exactly match local Line ID. `workspace` is interpreted only by selected Gateway. Client does not expose `list_workspaces()`, route by question, merge Workspace namespaces, or retry an accepted ask. `ask` advances selected Gateway Runtime Session and may cause any action available to Owner's full Pi, including shell commands and file changes; it is not idempotent.

Client may render safe remote failure codes and line identity, never remote bearer, private-key path, Tailcat address, Owner path, Runtime details, or internal Gateway diagnostics.

### Owner Gateway MCP

Gateway remains private behind Line transport. Its internal contract is:

```ts
list_workspaces(): {
  owner: { id: string; name: string; summary?: string };
  workspaces: Array<{ id: string; name: string; summary: string; available: boolean }>;
}

ask(input: { workspace: string; question: string }): {
  workspace: string;
  answer: string;
}
```

Gateway never accepts Agent-supplied Owner or Client identity. Remote bearer identifies Gateway Client identity. `available` means root exists, canonicalizes, and is readable; Pi startup failure does not change it.

## 3. Lines, identity, and authentication

Each Client uses one local high-entropy bearer. Every Agent request authenticates with it; MCP transport session cannot replace it. Client stores each Line privately with:

- local Line ID, stable while the record exists;
- expected Owner ID;
- Tailcat server address and remote port;
- Line-specific Tailcat private-key path;
- Line-specific remote Gateway Client ID and bearer.

Before any `ask`, Client establishes or restores that Line's stateful upstream MCP session, calls internal `list_workspaces()`, and validates returned `owner.id` against expected Owner ID. The verified session is then used for `ask`; every rebuilt upstream session repeats this handshake. Client never accepts an answer from an unverified session. Mismatch fails only that Line.

Each Line has two independent authentication layers:

1. That Line's distinct Tailcat private key enters Gateway Tailcat allowlist and authorizes encrypted transport.
2. That Line's distinct remote Gateway Client ID and bearer authorize Gateway MCP application requests and bind Runtime history.

Local Client bearer is separate from all remote bearers. Each Line must use credentials not shared with another Line. Rotation or revoke on one Line never changes other Lines or local bearer. Private keys and Line storage are readable only by current OS user; remote bearer is never shown after Line creation or logged.

Client persists its loopback port, local bearer hash, and private Line records in `~/.config/colleague-line/client.json` on macOS/Linux or `%APPDATA%\ColleagueLine\client.json` on Windows. Client process lock and reload state use `~/.local/share/colleague-line/client/` or `%LOCALAPPDATA%\ColleagueLine\client\`. Directories use `0700`, files `0600`, and Windows uses current-user ACL. Client config never stores local bearer plaintext; Line remote bearers remain private at rest and are redacted from list output.

Remote credential rotation keeps the remote Gateway Client ID and Runtime history but replaces that Line's Tailcat key and bearer. Gateway rotation invalidates old credentials first and returns the new bearer once through a trusted channel. Client then performs one atomic `line update`: abort and settle that Line's active requests, close its upstream MCP session and Connector, persist the new key path and bearer together, and reconnect. No old/new credential overlap or automatic ask retry is allowed.

## 4. Remote transport and failures

Gateway HTTP listens only on loopback. Per-Line Connector listens only on Client loopback and is raw TCP; Tailcat encrypts off-host traffic, provides NAT traversal and DERP fallback, creates no host route or DNS, and exposes only Gateway port. Loopback HTTP does not use TLS.

Tailcat Server uses persistent key, so server address remains stable across restart. Before a new bridge, Connector performs bounded `Client.Ping` for Tailcat re-registration. Bootstrap may retry before HTTP request starts. Once Client forwards Gateway request, it never retries it.

Each Line owns connection, remote bearer, cancellation state, and failure accounting. Tailcat bootstrap failure, allowlist denial, remote authentication failure, Owner-ID mismatch, Gateway failure, or Line restart fails selected Line only. Other Lines remain available. Client does not fall back to another Owner.

Cancellation travels two hops: Agent cancellation reaches Client stateful MCP transport; Client aborts selected Line request and closes Connector stream; Gateway receives cancellation and aborts Runtime turn. Client reports cancellation only after downstream abort settles or Gateway connection closes. No cancellation crosses Lines.

## 5. Gateway Runtime and persistence

Gateway uses stateful Streamable HTTP only for protocol cancellation. Every Gateway request revalidates remote bearer; MCP session is neither product identity nor history. Fixed Gateway limits: 32 MCP sessions globally, 4 per remote Gateway Client, 64 active HTTP requests globally, 16 per remote Gateway Client, 64 KiB uncompressed request body, 10-minute idle session expiry.

Gateway Runtime Session is keyed by authenticated remote Gateway Client plus Workspace. Different Gateway Clients and Workspaces use distinct Pi session IDs. Client never stores, merges, or replays history across Lines. Same key serializes asks; different keys may run concurrently. Each active binding owns one `pi --mode rpc --approve --session-id <id>` process with cwd set to selected Workspace. Idle processes stop after 10 minutes and restart lazily with same Pi session ID.

Gateway persists JSON config, Runtime binding metadata, tombstones, Tailcat server key, and transport state under:

```text
macOS/Linux: ~/.config/colleague-line/config.json
macOS/Linux state: ~/.local/share/colleague-line/
Windows config: %APPDATA%\ColleagueLine\config.json
Windows state: %LOCALAPPDATA%\ColleagueLine\
Pi global state and sessions: ~/.pi/agent/
```

Config includes Owner, loopback server, Workspaces, and remote Gateway Clients with bearer hashes and Tailcat public keys. State binds `remote Gateway Client + Workspace` to one Pi session ID. Pi owns session files in its default global session store. Revoking a Client or removing a Workspace retires active processes and removes Colleague Line bindings but does not delete Owner's global Pi archive. Atomic JSON writes and idempotent desired-state reconciliation apply. No database, automatic history deletion, public reset, knowledge index, or session adapter exists.

Gateway launches Owner's installed global Pi CLI directly. It passes no model, provider, settings, resource, tool, extension, skill, or session-directory override. `--approve` loads trusted Workspace resources in non-interactive RPC mode. Pi therefore uses Owner's default model and authentication, global settings, skills, extensions, full builtin tools, and `~/.pi/agent/sessions/`. Colleague Line does not confine filesystem access, filter tools, parse other agents' histories, or mediate Pi actions. This is a trusted remote-control capability, not a read-only security boundary.

## 6. Gateway lifecycle and errors

Gateway ask timeout is 120 seconds. Pi RPC uses strict LF-delimited JSONL with command IDs. `message_end` is authoritative answer content and `agent_settled` marks completion. Cancellation sends `clear_queue`, then `abort`, waits for `agent_settled`, preserves history, and never retries an accepted prompt. Failure to settle within five seconds causes one fatal Gateway shutdown; within ten-second shutdown window it closes Tailcat, HTTP, MCP, Runtime, and process lock before nonzero exit. User service restarts it.

Agent-facing Client errors identify safe layer and Line without leaking secrets: `UNAUTHORIZED`, `LINE_NOT_FOUND`, `LINE_UNAVAILABLE`, `OWNER_ID_MISMATCH`, `WORKSPACE_NOT_FOUND`, `WORKSPACE_UNAVAILABLE`, `INVALID_QUESTION`, `RUNTIME_UNAVAILABLE`, `RUNTIME_TIMEOUT`, `RUNTIME_FAILED`, `BUSY`, `CANCELLED`. Gateway internal errors retain prior safe MCP codes except Line-local codes. `/healthz` stays bearer-free, minimal, and Gateway-local; it does not probe Pi, Workspaces, Tailcat, or Lines.

## 7. CLI and services

Commands are role-prefixed. No `profile`, `connect`, or unprefixed role command remains.

```text
colleague-line gateway init --owner-id ... --owner-name ...
colleague-line gateway workspace add|list|update|remove ...
colleague-line gateway client add|list|rotate|revoke ...
colleague-line gateway doctor [--json]
colleague-line gateway serve

colleague-line client init
colleague-line client line key-create <line-id>
colleague-line client line add <line-id> --owner-id ... --remote-client-id ... --server ... --port ... --key ... --bearer -
colleague-line client line list [--json]
colleague-line client line update <line-id> --key ... --bearer - --yes
colleague-line client line remove <line-id> --yes
colleague-line client token rotate
colleague-line client doctor [--json]
colleague-line client serve
```

Gateway Client add creates one remote Gateway Client identity and bearer for exactly one Line and configures its distinct Tailcat key in the allowlist. Client Line add consumes Owner-issued values through a secure channel; required flags allow noninteractive use and stdin carries secrets. `line update` replaces key path and bearer atomically after Gateway rotation. Removing a Line deletes only local routing and credentials; its local ID may be reused later because remote identity and history stay Owner-controlled. `gateway serve` is Owner service. `client serve` is Agent-local MCP service. `doctor` checks own role configuration, global Pi executable, and transport readiness without starting a model turn or reading Workspace content. Pi model, provider, authentication, settings, tools, skills, and extensions are managed through Owner's normal global Pi.

## 8. Security

- Gateway and Connector bind loopback only; no `0.0.0.0`, Tailcat `all`, exit node, no-auth SSH, file service, host forwarding, personal Tailscale sharing, Funnel, subnet routing, or DNS exposure.
- Gateway validates Host and Origin; non-browser MCP may omit Origin, supplied Origin must be allowed.
- Server-generated identifiers; no paths, model, keys, tokens, usernames, Runtime IDs, session files, interface addresses, node metadata, questions, answers, or file contents in default logs.
- Gateway Workspace registration is manual. Root immutable; duplicate canonical roots rejected; nested roots allowed; deletion tombstones ID.
- Every remote Client is trusted with Owner-level Pi capability. Bearer or Tailcat-key compromise can expose or modify anything reachable by Owner's Pi.
- Gateway remote-client revoke removes bearer and Tailcat key, terminates that remote client requests, cancels current Runtime, removes its binding, and tombstones identity. Owner's global Pi session archive remains. Rotation replaces key and bearer while keeping binding and history.

## 9. Platform and delivery

Stack remains TypeScript, Bun, MCP SDK 1.29.x, Zod, global Pi RPC subprocesses, JSON files, Tailcat pinned commit `4d50a34f315d593d03c31f12a20ba8d163cbf321`, one small Go transport binary, and `bun test`. No database, ORM, DI framework, queue, web UI, vector store, transport plugin interface, or plugin framework.

macOS Apple Silicon and Linux x64 are target platforms. Windows x64 cross-build remains **Preview**, pending native ACL, reparse/junction, path case/drive/UNC, Bun, Pi, MCP, Tailcat, Gateway, and Client smoke acceptance. Intel Mac and Linux arm64 unsupported.

Delivery order: Gateway core and Runtime; Gateway MCP and cancellation; Client Line store and single Client MCP; Line Tailcat bridges and two-hop cancellation; role services, diagnostics, platform acceptance.

## 10. Acceptance

New acceptance proves:

- one Agent configures one Client MCP endpoint and authenticates with one local bearer;
- Client exposes exactly `list_lines()` and `ask({ line, workspace, question })`;
- `list_lines()` returns each configured Line with independently verified Owner and Workspace metadata, while one unavailable Line does not hide healthy Lines;
- two Lines reach separate Owners; selected Line validates expected Owner ID;
- Agent cannot call `list_workspaces()` or directly configure per-Owner Gateway MCP;
- Line credentials, transport failure, cancellation, and Runtime history remain isolated;
- selected ask traverses Agent → Client → Line → Gateway → Runtime and cancellation returns over both hops;
- Gateway retains internal `list_workspaces()` and `ask({ workspace, question })`, full global Pi Runtime, per-binding Pi session IDs, and restart recovery;
- Gateway and Client services restart and recover new connections; no accepted ask is retried;
- Windows artifacts and release notes remain Preview.

Previous practical verification that configured multiple Agent-facing MCP servers, one per Owner, is historical and invalid for this Agent-facing acceptance. Prior verified Gateway, Tailcat, Pi, cancellation, restart, security, and macOS/Linux facts remain technical input, not proof of Client multiplexing.
