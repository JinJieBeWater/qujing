# 每个 remote Gateway Client ID 与 Workspace 使用一个隐式 Runtime Session

Gateway 使用 `remote Gateway Client ID + Workspace ID` 定位连续回答历史，不暴露 Conversation 或 Thread ID。Gateway 内部 `ask` 只需 `workspace` 和 `question`；外部 Client 选择 Line 后转发，因此 Client 不公开 session 管理。

## 后果

每个组合只有一份串行历史，因此无关话题可能影响后续回答，也不能拆成独立 Thread。Pi 自己管理 compaction 与全局 session archive；释放空闲 Pi 进程不会删除 Runtime Session。MVP 不提供本地或远程 reset。删除 remote Gateway Client ID 或 Workspace 只移除 Colleague Line binding，不删除 Owner 的 Pi archive。未来若增加独立话题或 archive 删除，必须进行显式产品变更，不能加入隐藏路由规则。
