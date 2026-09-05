# 使用一个 local Node MCP multiplex 私有 Peer Links

外部 Agent 配置恰好一个本地 Qujing Node MCP endpoint，而非每个 Peer 一个 MCP server。Agent 不是 Peer。Local Node 私有管理多个 Peer Link；Peer ID 在记录存在期间稳定，记录删除后可复用。每条 Link 独占 expected remote Node ID、Tailcat server address/port/private key、remote Peer credential ID 和 bearer。

Local Node 对 Agent 只暴露 `list_peers()` 与 `ask({ peer, workspace, question })`。`list_peers()` 先返回 PeerDirectory 的可见候选，再独立查询已配对 Peer Link，在 Peer 下返回已验证 remote Node 及其公开 Workspaces；它不合并 Workspace namespace，单个 Peer 失败也不影响其他结果。Node 仍在 Peer Link 后保留内部 `list_workspaces()` 与 `ask({ workspace, question })`。Local Node 不自动选 Peer，不按问题路由，不共享或迁移 Runtime history，不提供旧直接配置兼容层。

每个 Peer Link 是独立故障与凭据边界。Local Node 在每次新建或恢复 upstream MCP session 时先调用 Node `list_workspaces()` 验证 expected remote Node ID，只有同一已验证 session 可以执行 `ask`；一个 Peer 的 transport、remote bearer、Node、取消或重启失败不能影响其他 Peer，也不允许 fallback。Agent 使用单独 local bearer；它不等于任何 Peer remote bearer。

后果：Agent 配置变为单一稳定 endpoint，Peer topology 留在 local Node 私有存储。必须验收单 local Node MCP multiplexing、two-hop cancellation、Peer isolation，以及 `ask` 对 `{peer, workspace}` 的显式选择。
