# Qujing specification

Status: Node/Peer mesh model. macOS Apple Silicon and Linux x64 transport, Runtime, cancellation, restart, and security facts remain valid technical input. Windows x64 remains Preview.

## 1. Topology

Qujing is a mesh of Nodes. Each installation has exactly one Node identity. A Node may expose local Workspaces through its private Node and may ask paired Peers through one local Agent-facing MCP endpoint.

The external Agent is not a Peer. It authenticates to the local Node with one local bearer, discovers visible Peer candidates, and must explicitly choose both `peer` and `workspace` on `ask`.

```text
Agent
  | one local bearer
  v
local Node MCP ── Peer Link A ── Tailcat ── Peer Node A ── Runtime
               └─ Peer Link B ── Tailcat ── Peer Node B ── Runtime
```

No central directory, automatic routing, shared history, migration path, compatibility layer for prior topology, or Agent-facing direct Node MCP connection exists.

`PeerDirectory` is a seam, not a network feature. MVP implementations are manual directory and empty directory only. Directory results mean visible candidates, not authorization, trust, availability, ranking, or routing.

## 2. Contracts

### Agent-facing local Node MCP

Local Node exposes exactly:

```ts
list_peers(): {
  peers: Array<{
    id: string;
    available: boolean;
    node?: { id: string; name: string; summary?: string };
    workspaces: Array<{
      id: string;
      name: string;
      summary: string;
      available: boolean;
    }>;
  }>;
}

ask(input: { peer: string; workspace: string; question: string }): {
  peer: string;
  workspace: string;
  answer: string;
}
```

`list_peers()` combines manual PeerDirectory candidates with paired Peer Links. For paired Peers, it queries each Peer Link independently and returns verified remote Node metadata plus that Node's public Workspaces. For unpaired manual candidates, unavailable Peers, unauthorized Peers, or identity mismatches, it may return `available: false`, no `node`, and empty `workspaces`. One failed Peer cannot fail whole discovery.

Discovery never authorizes `ask`. `ask.peer` must match one authenticated Peer Link; `ask.workspace` is interpreted only by selected Peer Node. Local Node does not expose `list_workspaces()` to Agent, route by question, merge Workspace namespaces, choose fallback Peers, or retry accepted asks. `ask` advances selected Peer Runtime Session and may cause any action available to Peer Node's Runtime, including shell commands and file changes; it is not idempotent. Consultation prompt asks Runtime to behave read-only, but MCP metadata remains `readOnlyHint: false` and `destructiveHint: true` because prompts are not permission controls.

Local Node may render safe remote failure codes and Peer identity, never remote bearer, private-key path, Tailcat address, peer-local paths, Runtime details, or internal Node diagnostics.

### Peer Node MCP

Node remains private behind Peer Link transport. Its internal contract is:

```ts
list_workspaces(): {
  node: { id: string; name: string; summary?: string };
  workspaces: Array<{ id: string; name: string; summary: string; available: boolean }>;
}

ask(input: { workspace: string; question: string }): {
  workspace: string;
  answer: string;
}
```

Node never accepts Agent-supplied identity. Remote bearer identifies authenticated Peer credential. `available` means root exists, canonicalizes, and is readable; Runtime startup failure does not change it.

## 3. Node identity, Peer identity, and authentication

Each Qujing installation has one Node identity. That identity names local Workspace publisher and remote Peer target. Running both local Agent-facing MCP and Node processes on one machine does not create multiple product identities.

Each local Node uses one local high-entropy bearer for Agent requests. MCP transport session cannot replace it. Agent identity is not Peer identity.

Local Node stores each Peer Link privately with:

- local Peer ID, stable while record exists;
- expected remote Node ID;
- Tailcat server address and remote port;
- Peer-specific Tailcat private-key path;
- Peer-specific remote credential ID and bearer.

Before any `ask`, local Node establishes or restores selected Peer Link's stateful upstream MCP session, calls internal `list_workspaces()`, and validates returned `node.id` against expected remote Node ID. The verified session is then used for `ask`; every rebuilt upstream session repeats this handshake. Local Node never accepts an answer from an unverified session. Mismatch fails only that Peer.

Each Peer Link has two independent authentication layers:

1. That Link's distinct Tailcat private key enters remote Node Tailcat allowlist and authorizes encrypted transport.
2. That Link's distinct remote credential ID and bearer authorize Node MCP application requests and bind Runtime history.

Local Agent bearer is separate from all remote bearers. Each Peer Link must use credentials not shared with another Peer Link. Rotation or revoke on one Peer never changes other Peers or local bearer. Private keys and Peer Link storage are readable only by current OS user; remote bearer is never shown after pairing or logged.

Local Node persists loopback port, local bearer hash, manual PeerDirectory records, and private Peer Links in `~/.config/qujing/agent.json` on macOS/Linux or `%APPDATA%\Qujing\agent.json` on Windows. Process lock and reload state use `~/.local/share/qujing/agent/` or `%LOCALAPPDATA%\Qujing\agent\`. Directories use `0700`, files `0600`, and Windows uses current-user ACL. Config never stores local bearer plaintext; remote bearers remain private at rest and are redacted from list output.

Remote credential rotation keeps remote credential ID and Runtime history but replaces that Peer Link's Tailcat key and bearer. Remote Node rotation invalidates old credentials first and returns new bearer once through a trusted channel. Local Node then performs one atomic peer credential update: abort and settle active requests for that Peer, close upstream MCP session and Connector, persist new key path and bearer together, and reconnect. No old/new credential overlap or automatic ask retry is allowed.

## 4. PeerDirectory and discovery

PeerDirectory is a replaceable seam with only two supported MVP implementations:

- empty directory, returning no unpaired candidates;
- manual directory, returning user-entered candidate Peer IDs, names, summaries, and optional hints.

PeerDirectory output is visible candidate data only. It never grants Tailcat access, MCP bearer access, Workspace access, Runtime history, trust, or routing preference. `list_peers()` may show manual candidates, but `ask({ peer, workspace })` succeeds only after pairing creates an authenticated Peer Link and selected Workspace is available.

No central registry, broadcast discovery, DHT, LAN scan, public search, invite marketplace, auto-pairing, or compatibility import exists.

## 5. Remote transport and failures

Node HTTP listens only on loopback. Per-Peer Connector listens only on local loopback and is raw TCP; Tailcat encrypts off-host traffic, provides NAT traversal and DERP fallback, creates no host route or DNS, and exposes only Node port. Loopback HTTP does not use TLS.

Tailcat Server uses persistent key, so server address remains stable across restart. Before a new bridge, Connector performs bounded `Agent.Ping` for Tailcat re-registration. Bootstrap may retry before HTTP request starts. Once local Node forwards Node request, it never retries it.

Each Peer Link owns connection, remote bearer, cancellation state, and failure accounting. Tailcat bootstrap failure, allowlist denial, remote authentication failure, Node-ID mismatch, Node failure, or Peer Link restart fails selected Peer only. Other Peers remain available. Local Node does not fall back to another Peer.

Cancellation travels two hops: Agent cancellation reaches local Node stateful MCP transport; local Node aborts selected Peer request and closes Connector stream; Node receives cancellation and aborts Runtime turn. Local Node reports cancellation only after downstream abort settles or Node connection closes. No cancellation crosses Peers.

## 6. Runtime and persistence

Node uses stateful Streamable HTTP only for protocol cancellation. Every Node request revalidates remote bearer; MCP session is neither product identity nor history. Fixed Node limits: 32 MCP sessions globally, 4 per remote Peer credential, 64 active HTTP requests globally, 16 per remote Peer credential, 64 KiB uncompressed request body, 10-minute idle session expiry.

Runtime Session is keyed by authenticated remote Peer credential plus Workspace. Different Peers and Workspaces use distinct Runtime session IDs. Local Node never stores, merges, or replays history across Peers. Same key serializes asks; different keys may run concurrently. Each active binding owns one Runtime backend process or harness run with cwd set to selected Workspace. Idle Runtime entries stop after 10 minutes and restart lazily with same Runtime session ID.

Node persists JSON config, Runtime binding metadata, tombstones, Tailcat server key, and transport state under:

```text
macOS/Linux: ~/.config/qujing/config.json
macOS/Linux state: ~/.local/share/qujing/
Windows config: %APPDATA%\Qujing\config.json
Windows state: %LOCALAPPDATA%\Qujing\
Pi Runtime state and sessions: ~/.pi/agent/
TanStack Runtime state: ~/.local/share/qujing/tanstack/
```

Config includes Node identity, loopback server, Workspaces, runtime config, and remote Peer credentials with bearer hashes and Tailcat public keys. State binds `remote Peer credential + Workspace` to one Runtime Session ID. Revoking a remote Peer credential or removing a Workspace retires active processes and removes Qujing bindings but does not delete backend-owned transcript/session state: built-in Pi RPC keeps Pi state under `~/.pi/agent/`; TanStack ACP keeps transcript/run state under Node state. Atomic JSON writes and idempotent desired-state reconciliation apply. No database, automatic history deletion, public reset, knowledge index, or session adapter exists.

Node Runtime supports two backends. Built-in Pi RPC launches `pi --mode rpc`, verifies the Qujing Runtime Session ID, and applies explicit `provider/model` through Pi RPC `set_model`. TanStack ACP launches configured ACP-compatible CLI through `@tanstack/ai`, `@tanstack/ai-acp`, `@tanstack/ai-sandbox` local process provider, `@tanstack/ai-persistence`, and `@tanstack/ai/locks`. It uses Qujing Runtime Session ID as TanStack `threadId`, a fresh `runId` per ask, file-backed TanStack messages/runs stores under Node state, and a file-backed sandbox instance store. It captures ACP session ID emitted by harness and passes it as `modelOptions.sessionId` on later asks. `authMode` defaults to `host`; `permissionMode` defaults to `bypassPermissions`; permissions run headless.

Appended prompt defines Qujing as private colleague consultation, asks Runtime to remain read-only, and tells Runtime to choose evidence according to question from relevant code, project documents, Git, Skills, and Agent histories. It does not impose fixed lookup order. Qujing does not parse, index, merge, or replay other agents' histories; Runtime may inspect relevant records itself using configured capabilities.

Prompt does not confine filesystem access, filter tools, disable extensions, or mediate Runtime actions. This remains trusted remote-control capability, not read-only security boundary.

## 7. Node lifecycle and errors

Node ask timeout is 120 seconds. Runtime cancellation clears queued work, aborts active turn, and waits for idle settlement. TanStack ACP cancellation aborts TanStack chat `AbortController`, which cancels ACP session and spawned harness process through local process sandbox. Failure to settle within five seconds causes one fatal Node shutdown; within ten-second shutdown window it closes Tailcat, HTTP, MCP, Runtime, and process lock before nonzero exit. User service restarts it.

Agent-facing errors identify safe layer and Peer without leaking secrets: `UNAUTHORIZED`, `PEER_NOT_FOUND`, `PEER_UNAVAILABLE`, `NODE_ID_MISMATCH`, `WORKSPACE_NOT_FOUND`, `WORKSPACE_UNAVAILABLE`, `INVALID_QUESTION`, `RUNTIME_UNAVAILABLE`, `RUNTIME_TIMEOUT`, `RUNTIME_FAILED`, `BUSY`, `CANCELLED`. Node internal errors retain prior safe MCP codes except Peer-local codes. `/healthz` stays bearer-free, minimal, and Node-local; it does not probe Runtime, Workspaces, Tailcat, or Peers.

## 8. CLI and services

Product identity is Node and Peer. Current implementation process roles remain local Agent-facing MCP service and Node service; commands are task-first, with role arguments only where an operation exists for both processes. No role-prefixed command or direct per-Peer Agent MCP configuration exists. On macOS, service installation creates private `qujing-node` or `qujing-agent` launchers so Background Items identify process role instead of displaying `qj`; these are not user commands.

```text
qj init node --node-id ... --node-name ...
qj init agent
qj workspace add|list|update|remove ...
qj peer invite <id> --key ... [--out <path|->]
qj peer accept <peer-id> --from <path|-> [--key <private-key-path>]
qj peer list|rotate|revoke ...
qj runtime set-pi --model <provider/model> [--binary <pi>]
qj runtime set-acp <name> --model ... --command ... [--auth <host|api-key>] [--auth-method-id ...] [--permission <default|acceptEdits|bypassPermissions>]
qj peer key-create|list|update|remove ...
qj token rotate
qj doctor node|agent [--json]
qj serve node|agent
qj service install|remove node|agent --yes
```

`peer invite` requires live Node, creates one remote Peer credential and bearer for exactly one Peer Link, and waits until Node applies its distinct Tailcat key before publishing one private pairing bundle. Bundle carries remote Node ID, remote Peer credential ID, Tailcat coordinates, and remote bearer as one exact handoff. `peer accept` reads that bundle from private file or stdin, derives standard key path from Peer ID unless overridden, verifies remote Node, then persists Peer Link. Credential update replaces key path and bearer atomically after remote rotation. Removing Peer Link deletes only local routing and credentials; local Peer ID may be reused later because remote identity and history stay remote-Node controlled. `runtime set-pi` configures built-in Pi RPC with explicit model. `runtime set-acp` configures a custom TanStack ACP Runtime whose model and command are managed through Qujing runtime config. Both retire active Runtime entries without deleting bindings. `serve node` hosts local Node Workspaces and Runtime. `serve agent` hosts Agent-facing local MCP and Peer Links. `doctor` checks selected process-role configuration, configured Runtime, and transport readiness without starting model turn or reading Workspace content. Qujing always adds only fixed Runtime prompt.

## 9. Security

- Node and Connector bind loopback only; no `0.0.0.0`, Tailcat `all`, exit node, no-auth SSH, file service, host forwarding, personal Tailscale sharing, Funnel, subnet routing, or DNS exposure.
- Node validates Host and Origin; non-browser MCP may omit Origin, supplied Origin must be allowed.
- Pairing bundles contain remote bearer and private network coordinates. File output is current-user-only; transfer through trusted channel and remove after successful Peer import.
- Server-generated identifiers; no paths, model, keys, tokens, usernames, Runtime IDs, session files, interface addresses, node metadata, questions, answers, or file contents in default logs.
- Workspace registration is manual. Root immutable; duplicate canonical roots rejected; nested roots allowed; deletion tombstones ID.
- Every authenticated Peer is trusted with Node-level Runtime capability. Bearer or Tailcat-key compromise can expose or modify anything reachable by configured Runtime.
- Remote Peer credential revoke removes bearer and Tailcat key, terminates that Peer requests, cancels current Runtime, removes its binding, and tombstones identity. Rotation replaces key and bearer while keeping binding and history.

## 10. Platform and delivery

Stack remains TypeScript, Bun, Effect 4 RC, `@effect/platform-bun`, Effect Schema, Effect's native MCP server, MCP SDK 1.29.x for upstream MCP agent, TanStack AI ACP harness packages, JSON files, Tailcat pinned commit `4d50a34f315d593d03c31f12a20ba8d163cbf321`, and one small Go transport binary. Zod has no source imports; its package remains only because upstream MCP SDK declares it as required peer. Bun contract tests and Vitest + `@effect/vitest` cover their respective runtime boundaries. No database, ORM, queue, web UI, vector store, transport plugin interface, plugin framework, or network PeerDirectory implementation.

macOS Apple Silicon and Linux x64 are target platforms. Windows x64 cross-build remains **Preview**, pending native ACL, reparse/junction, path case/drive/UNC, Bun, MCP, Tailcat, Node, Runtime, and Agent-facing MCP smoke acceptance. Intel Mac and Linux arm64 unsupported.

Delivery order: Node core and Runtime; Node MCP and cancellation; Agent-facing local Node MCP; Peer Link store; Peer Tailcat bridges and two-hop cancellation; PeerDirectory empty/manual seam; role services, diagnostics, platform acceptance.

## 11. Acceptance

New acceptance proves:

- one Qujing installation has one Node identity;
- local Agent is not Peer and authenticates with one local bearer;
- local Node exposes `list_peers()` and `ask({ peer, workspace, question })`;
- `list_peers()` returns visible manual candidates and independently verified paired Peer Workspace metadata, while one unavailable Peer does not hide healthy Peers;
- `ask` requires explicit Peer and Workspace, and cannot be satisfied by discovery alone;
- two Peer Links reach separate remote Nodes; selected Peer validates expected remote Node ID;
- Agent cannot call `list_workspaces()` or directly configure per-Peer Node MCP;
- Peer credentials, transport failure, cancellation, and Runtime history remain isolated;
- selected ask traverses Agent → local Node → Peer Link → Node → Runtime and cancellation returns over both hops;
- Node retains internal `list_workspaces()` and `ask({ workspace, question })`, per-binding Runtime Session IDs, and restart recovery;
- Runtime loads Qujing consultation prompt, keeps per-binding Runtime Session ID, and preserves backend state where supported;
- Node and Agent-facing services restart and recover new connections; no accepted ask is retried;
- empty and manual PeerDirectory implementations exist, and no network discovery exists;
- Windows artifacts and release notes remain Preview.
