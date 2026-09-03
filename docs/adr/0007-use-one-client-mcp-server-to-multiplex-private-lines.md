# 使用一个 Client MCP server multiplex 私有 Lines

外部 Agent 配置恰好一个本地 Qujing Client MCP server，而非每 Owner 一个 MCP server。Client 私有管理多个 Line；Line ID 在记录存在期间稳定，记录删除后可复用。每条 Line 独占 expected Owner ID、Tailcat server address/port/private key、remote Gateway Client ID 和 bearer。

Client 对 Agent 只暴露 `list_lines()` 与 `ask({ line, workspace, question })`。`list_lines()` 独立查询每条 Line，在 Line 下返回已验证 Owner 及其公开 Workspaces；它不合并 Workspace namespace，单条 Line 失败也不影响其他结果。Gateway 仍在 Line 后保留内部 `list_workspaces()` 与 `ask({ workspace, question })`。Client 不自动选 Line，不按问题路由，不共享或迁移 Runtime history，不提供旧每 Owner 直接配置兼容层。

每 Line 是独立故障与凭据边界。Client 在每次新建或恢复 upstream MCP session 时先调用 Gateway `list_workspaces()` 验证 expected Owner ID，只有同一已验证 session 可以执行 `ask`；一个 Line 的 transport、remote bearer、Gateway、取消或重启失败不能影响其他 Line，也不允许 fallback。Agent 使用单独 local bearer；它不等于任何 Line remote bearer。

后果：Agent 配置变为单一稳定 endpoint，Owner topology 留在 Client 私有存储。旧“多个 Agent-facing MCP、每 Owner 一个”实机验收不再证明当前 Agent-facing contract，必须重新验收单 Client multiplexing、two-hop cancellation 和 Line isolation。
