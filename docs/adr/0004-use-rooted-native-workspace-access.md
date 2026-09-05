# 使用 rooted native helper 执行 Workspace 只读访问

Status: Superseded by `0009-add-tanstack-acp-runtime.md`.
Qujing 不再使用 Bun 的 `realpath` 校验后再按路径读取文件。该模式无法关闭并发 rename 与 symlink swap 的 TOCTOU 窗口。

曾计划为每次 Runtime `read`、`grep`、`find` 或 `ls` 调用启动一个独立 Go helper。Helper 从 stdin 接收一个 bounded request，使用 Go `os.Root` 完成 rooted traversal、打开与读取，并返回 bounded result 或固定错误码。Abort 直接终止 helper 进程。

## 后果

- Workspace confinement、敏感路径、工作预算、线性时间正则、取消和安全错误集中在一个深 Module。
- Bun 只保留 tool adapter，不再重复安全路径判断。
- Release 增加一个通用 companion binary；它不是 plugin host，也不暴露任意命令执行。
- Windows 在原生 reparse/junction 与 ACL 验收完成前保持 Preview。
