# Qujing glossary

**Agent**: External MCP consumer. Configures one local Client MCP server.

**Client**: Local Qujing process serving one Agent. It owns many private Lines and exposes only `list_lines()` and `ask({ line, workspace, question })`.

**Line**: Private Client configuration for one Owner Gateway. Its local Line ID is stable while the record exists and may be reused only after removal. Every Line has its own expected Owner ID, Tailcat server address, remote port, Tailcat private key, remote Gateway Client identity, and remote bearer.

**Owner**: Real person represented by one Gateway.

**Gateway**: Owner-local service. Manages Owner Workspaces and Runtime; its internal MCP contract is `list_workspaces()` and `ask({ workspace, question })`.

**Workspace**: Owner-registered canonical root directory with public ID, name, and summary. Its root never changes; deleted IDs never return.

**Runtime**: Owner's full global Pi environment answering Workspace questions under Qujing's consultation prompt, with Owner-level tools, settings, authentication, extensions, skills, and session access.

**Runtime Session**: Private continuous history for one authenticated Gateway Client and one Workspace. No public ID, topic switching, or reset.

**Connector**: Client-side loopback TCP bridge for one Line's Tailcat path. It does not parse HTTP or MCP.
