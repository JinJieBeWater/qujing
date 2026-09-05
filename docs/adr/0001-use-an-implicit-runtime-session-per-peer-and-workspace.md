# 每个 remote Peer credential 与 Workspace 使用一个隐式 Runtime Session

Node 使用 `remote Peer credential ID + Workspace ID` 定位连续回答历史，不暴露 Conversation 或 Thread ID。Node 内部 `ask` 只需 `workspace` 和 `question`；外部 Agent-facing Node 已经显式选择 `peer` 后转发，因此 Qujing 不公开 session 管理。

## 后果

每个组合只有一份串行历史，因此无关话题可能影响后续回答，也不能拆成独立 Thread。TanStack 管理 transcript/run state；释放空闲 Runtime 进程不会删除 Runtime Session。MVP 不提供本地或远程 reset。删除 remote Peer credential ID 或 Workspace 只移除 Qujing binding，不删除 TanStack transcript state。未来若增加独立话题或 archive 删除，必须进行显式产品变更，不能加入隐藏路由规则。
