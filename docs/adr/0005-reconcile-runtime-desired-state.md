# 通过 desired-state reconciliation 管理 Runtime 生命周期

Config 与永久 remote Gateway Client ID/Workspace tombstone 是 Runtime 的 durable desired state。Gateway 使用一个 Runtime Coordinator 串行 ask admission 与配置 reconciliation，不增加数据库或通用事务日志。

Ask 必须先在 lifecycle gate 内重读 effective config、创建 binding 并登记可取消 lease。Revoke、Workspace remove 和 credential rotation 先 block 对应 scope，再取消活动 lease、等待 Pi settlement，并执行幂等 binding 清理。

## 后果

- 配置删除或轮换后不能在 cleanup 之后重新创建旧 binding。
- Credential rotation 重启内存进程，但保留同一个 Pi session ID。
- Revoke 和 Workspace remove 删除 Qujing binding，不删除 Owner 的全局 Pi session archive。
- Startup reconciliation 清理指向已删除 Client 或 Workspace 的 binding metadata。
