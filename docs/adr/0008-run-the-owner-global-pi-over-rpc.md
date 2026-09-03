# 直接通过 RPC 运行 Owner 的全局 Pi

Qujing Gateway 为每个活跃 `remote Gateway Client + Workspace` 启动一个真实 `pi --mode rpc --approve --session-id <id>` 子进程。进程 cwd 是 Workspace，其他 Pi 配置保持默认：Owner 的模型、认证、settings、skills、extensions、builtin tools 和 `~/.pi/agent/sessions/`。

## 考虑过的方案

- 受限 `AgentSession` SDK 能提供只读工具和路径隔离，但复制了 Pi 的资源、工具、session 和生命周期管理，并阻断 Owner 已有全局 Pi 能力。
- 为多种 coding agent 建立 session adapters 会引入发现、格式归一化、映射和索引复杂度，且仍不能等价运行 Owner 的真实工作环境。
- 全局 Pi RPC 让 Pi 自己管理模型、资源、工具和 session；Qujing 只管理路由、认证、进程、并发、取消和恢复。

## 后果

- `0003-embed-pi-agent-session-sdk.md` 与 `0004-use-rooted-native-workspace-access.md` 被本决策取代。
- Gateway 不再固定模型，也不发布 rooted helper。
- Runtime Session ID 同时作为 Pi `--session-id`，session 进入默认全局 Pi store；Gateway restart 使用同一 ID 恢复。
- Gateway 只附加 Qujing 咨询提示词，不覆盖 Owner 的 tools、extensions、skills、模型、认证、settings 或 session store。提示词引导只读行为，但不构成权限边界。
- RPC 必须按 byte `0x0A` framing，按 command ID 关联 response，以 `message_end` 获取最终回答，并等待 `agent_settled`。
- 取消顺序固定为 `clear_queue`、`abort`、等待 settlement。已接受 prompt 不重试。
- Owner 的 global Pi extensions 若请求 headless 交互，Gateway 对 confirm 自动确认、对 select 采用首个选项、对 input/editor 采用空值或预填值，既不阻塞 Runtime，也不引入额外安全审批层。
- 每个已认证 remote Gateway Client 获得 Owner-level Pi 能力，包括 shell、文件修改、全局 sessions 和 credentials 访问。这是明确的 trusted remote-control 模型。
