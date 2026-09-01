# 直接嵌入 Pi AgentSession SDK

Status: Superseded by `0008-run-the-owner-global-pi-over-rpc.md`.
Colleague Line 使用 `@earendil-works/pi-coding-agent` 的 `AgentSession` SDK，不通过 `pi --mode rpc` 子进程控制 Pi。Colleague Line 是 TypeScript/Bun 应用；Pi 官方文档建议 Node.js/TypeScript 集成直接使用 `AgentSession`，SDK 已在当前 Bun 环境完成无工具 Session 初始化验证。

## 考虑过的方案

- RPC 子进程提供单 Session 硬终止和故障隔离，但增加进程管理、JSONL framing、command correlation 和协议测试。
- SDK 直接提供 tool allowlist、显式 ResourceLoader、SessionManager、events、`clearQueue()`、`abort()`、`waitForIdle()` 和 `dispose()`，更容易确保只加载 Colleague Line 管理的工具与配置。

## 后果

每个活跃 `remote Gateway Client ID + Workspace` 使用独立 `AgentSession`，但共享 Gateway 进程。若 `abort()` 在 5 秒内无法 settlement，Colleague Line 无法只杀死单个 Session，因此 Gateway 必须非零退出并由用户服务重启。持久 Runtime Session 可在重启后恢复；已经被 Pi 接受的 prompt 不得自动重试。只有真实故障证明需要单 Session 进程隔离时，才重新评估 RPC 子进程。
