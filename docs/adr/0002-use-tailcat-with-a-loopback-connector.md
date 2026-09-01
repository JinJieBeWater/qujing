# 使用 Tailcat 与每 Line loopback Connector

每个 Client Line 使用固定版本 Tailcat 和私有 loopback raw-TCP Connector 到一个 Owner Gateway。这样 Agent 只配置本地 Client MCP，Owner 不暴露个人 tailnet，Tailcat 提供加密 NAT traversal 与 DERP fallback，不创建 host route 或 DNS。

Line 保存 Tailcat server address、remote port 与 private-key path；Connector 不解析 HTTP/MCP。Gateway HTTP 和 Connector 都只监听 loopback。Tailcat 只转发 Gateway port，禁止 `all`、exit node、no-auth SSH、文件服务和其他 host forwarding。

拒绝共享 Owner 个人 Tailscale、`tsnet`/container 第二 tailnet、EasyTier、SSH tunnel、公网 reverse proxy，以及无需 Connector 的 Tailcat SOCKS：它们扩大信任或运维面，且 Bun/Node MCP Client 不会可靠使用 SOCKS。Client 不保留旧每 Owner 直接配置概念。

后果：每 Line 有独立 transport failure 域。每条 Line 使用不与其他 Line 共享的 Tailcat private key、remote Gateway Client ID 和 bearer；前者进入 Gateway allowlist，后两者形成独立应用身份并绑定 Runtime history。Client 控制两端匹配 binary，固定已验证 upstream commit；官方 best-effort DERP 为 MVP，真实可靠性或延迟不足才增加独立 `derper`。
