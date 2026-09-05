# Qujing glossary

**Agent**: External MCP consumer. It connects to one local Qujing MCP endpoint and is not a Peer in the Qujing mesh.

**Node**: One Qujing identity controlled by one person. A Node can publish Workspaces, authenticate paired Peers, run a local Runtime, and ask other Peers. Each installation has one Node identity; implementation roles such as local MCP service, private Node, and transport Connector are process boundaries, not separate product identities.

**Peer**: Another Qujing Node visible to the local Node as a candidate. Visibility is discovery only; `ask` still requires an authenticated peer link and explicit Workspace selection.

**PeerDirectory**: Seam that returns visible Peer candidates. MVP implementations are empty directory and manual directory only: no central registry, LAN scan, network discovery, auto-pairing, ranking, or routing.

**Peer Link**: Private local configuration for one paired Peer. It has a local Peer ID, expected remote Node ID, Tailcat server address, remote port, Tailcat private key, remote peer credential ID, and remote bearer. The local ID is stable while the record exists and may be reused only after removal.

**Node MCP**: Node-local loopback service behind a Peer Link. It manages that Node's Workspaces and Runtime. Its internal MCP contract is `list_workspaces()` and `ask({ workspace, question })`.

**Workspace**: Node-registered canonical root directory with public ID, name, and summary. Its root never changes; deleted IDs never return.

**Runtime**: Node's configured agent backend answering Workspace questions under Qujing's consultation prompt. Built-in Pi RPC runs Pi with an explicit model; TanStack ACP runs a configured ACP-compatible agent with that Node's process permissions.

**Runtime Session**: Private continuous history for one authenticated Peer and one Workspace. No public ID, topic switching, or reset.

**Connector**: Loopback TCP bridge for one Peer Link's Tailcat path. It does not parse HTTP or MCP.
