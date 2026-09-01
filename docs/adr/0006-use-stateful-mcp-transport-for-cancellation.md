# 为两跳 cancellation 使用有界 stateful MCP transport

Client 与 Gateway 都使用 stateful MCP transport，仅关联协议 cancellation。产品身份和历史不依赖 MCP session：Client 每 request 校验本地 bearer；Gateway 每 request 校验该 Line remote bearer；Gateway Runtime Session 仍由 remote Gateway Client + Workspace 定位。

官方 SDK cancellation 用独立 `notifications/cancelled` request。无状态 transport 无法关联正在执行的 `ask`，Runtime 收不到 AbortSignal。因此 Client 将 Agent cancellation 关联到 selected Line request，关闭 Connector stream；Gateway stateful transport 将取消传到同一 Runtime turn。取消不得跨 Line，Gateway 不得重试已接受 prompt。

Gateway session 上限固定全局 32、每 remote Gateway Client 4；活动 request 全局 64、每 remote Gateway Client 16；body 最大 64 KiB；空闲 session 10 分钟释放。Client 为本地 Agent 采用等价有界 session/request 限制，具体数值由实现验收确定。

后果：stateful MCP 不是公开对话、授权或路由层。远程 credential revoke 关闭对应 Gateway session 与请求；Line 失败或取消只影响 selected Line。
