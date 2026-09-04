# 增加 TanStack ACP Runtime

Qujing Gateway 保留默认全局 Pi Runtime，同时允许 Owner 用 TanStack AI ACP harness 替换 Runtime 后端。Agent-facing Client MCP 合同不变：Agent 仍只显式选择 Line 与 Workspace。

## 决策

Gateway config 可选 `runtime`：

```json
{
  "kind": "tanstack-acp",
  "name": "codex",
  "model": "gpt-5-codex",
  "command": "codex --acp --model {model} --cwd {cwd}",
  "authMode": "host",
  "permissionMode": "bypassPermissions"
}
```

`qj runtime set-acp` 写入该配置；`qj runtime use-pi` 删除该配置并回到默认 Pi Runtime。

TanStack Runtime 使用：

- `@tanstack/ai` `chat()`；
- `@tanstack/ai-acp` `acpCompatible()`；
- `@tanstack/ai-sandbox` + `localProcessSandbox()`；
- `@tanstack/ai-persistence` file-backed messages/runs stores；
- `@tanstack/ai/locks` in-process lock store；
- file-backed sandbox instance store。

Qujing Runtime Session ID 映射为 TanStack `threadId`；每次 `ask` 使用新的 `runId`。Harness 发出的 ACP session ID 被持久化，后续 ask 通过 `modelOptions.sessionId` 恢复。若 harness 无法恢复，TanStack ACP adapter 会退回新 session，并用持久 transcript 构造 prompt。

## 后果

- 单 Line 单 Workspace 的串行、timeout、lease、reconciliation、Line 隔离保持在 Qujing Runtime pool 与 Coordinator 中。
- Runtime 后端变更会退休现有 Runtime entries，但不删除 Runtime binding 或 transcript。
- TanStack local process sandbox 没有安全隔离；这符合当前 trusted remote-control 模型。
- 只支持 ACP-compatible CLI。非 ACP agent 需要外部 wrapper 或未来专用 adapter。
- 双向通话、Agent-facing runtime 选择、Docker/remote sandbox、durable stream takeover 不在本决策内。
