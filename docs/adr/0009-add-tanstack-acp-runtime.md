# 使用 TanStack ACP Runtime

Qujing Node 用 TanStack AI ACP harness 跑通用 ACP agent，同时保留内置 Pi RPC 后端给 Pi 模型选择。Agent-facing local Node MCP 合同不变：Agent 仍只显式选择 Peer 与 Workspace。

## 决策

Pi uses `runtime set-pi --model <provider/model>` and sends Pi RPC `set_model` after session open. Custom ACP agents use `runtime set-acp`.

```json
{
  "kind": "pi-rpc",
  "model": "openai-codex/gpt-5.5"
}
```

`qj runtime set-pi` writes built-in Pi RPC config. `qj runtime set-acp` writes custom ACP config. 未配置 Runtime 时，`qj doctor` 与真实 `ask` 失败并提示先配置 Runtime。

TanStack Runtime 使用：

- `@tanstack/ai` `chat()`；
- `@tanstack/ai-acp` `acpCompatible()`；
- `@tanstack/ai-sandbox` + `localProcessSandbox()`；
- `@tanstack/ai-persistence` file-backed messages/runs stores；
- `@tanstack/ai/locks` in-process lock store；
- file-backed sandbox instance store。

Qujing Runtime Session ID 映射为 TanStack `threadId`；每次 `ask` 使用新的 `runId`。Harness 发出的 ACP session ID 被持久化，后续 ask 通过 `modelOptions.sessionId` 恢复。若 harness 无法恢复，TanStack ACP adapter 会退回新 session，并用持久 transcript 构造 prompt。

## 后果

- 单 Peer 单 Workspace 的串行、timeout、lease、reconciliation、Peer 隔离保持在 Qujing Runtime pool 与 Coordinator 中。
- Runtime 后端变更会退休现有 Runtime entries，但不删除 Runtime binding 或 transcript。
- TanStack local process sandbox 没有安全隔离；这符合当前 trusted remote-control 模型。
- Pi 走内置 RPC；其他 agent 需要 ACP-compatible CLI。
- 双向通话、Agent-facing runtime 选择、Docker/remote sandbox、durable stream takeover 不在本决策内。
