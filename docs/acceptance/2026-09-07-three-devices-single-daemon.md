# 三设备单 daemon 验收 — 2026-09-07

## 结论

三设备的正常询问、真实工具读取、历史延续和手动重启恢复已运行成功。**本轮未通过完整验收**：不存在的 Workspace 返回错误码不符；取消后的退出与自动恢复尚未确认；daemon 退出后发现 Connector 残留。

这些是当前构建的观测结果，尚未确定问题是否由单 daemon 改动引入。

## 构建与设备

- 源码基点：`dd2f9a1008e32181fbedda283a8eecda40209791`。
- 叠加未提交更改的 `git diff --binary` SHA-256：`a35e6c3649a194087bc8107003334be392b47837e0cf41b896d98e16db8ef81b`。
- 版本号：`0.1.2`。验收期间未改业务源码；上述摘要不包含本报告。
- 三台分别为当前本机 Linux x64、一台 Apple Silicon Mac、一台 Omarchy Linux x64。不是两台 Mac。
- 本机询问 Mac、Omarchy；Omarchy 反向询问本机。
- 三台均运行同一源码构建的 `qj serve`，使用独立测试目录、Node 端口 `44310`、本机 MCP 端口 `44311`。未安装测试系统服务。
- Runtime 使用宿主全局 Pi，显式模型为 `openai-codex/gpt-6-astra`；未测试 TanStack ACP。
- MCP 调用由独立 SDK 探针发起，不是人工操作某个 Agent 产品的 UI。回答端实际运行 Pi 和工具。

发布包校验值在传输后逐台核对一致：

```text
172d3c4772facfc15fe0a41ae845a575d8113fae4621856e8139be2d96fa03a7  qujing-v0.1.2-darwin-arm64.tar.gz
8c0d8d61d12ecf1d5bcdc5467f43a34aa4ad476c736a3e3b4e11d811d4496844  qujing-v0.1.2-linux-x64.tar.gz
```

## 已通过的现场检查

| 检查                | 证据                                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| 三台统一启动与诊断  | 三台输出 `qujing: ready`，各自 `qj doctor --json` 的全部检查通过                                |
| 单一 Agent MCP 入口 | 工具恰为 `list_peers`、`ask`；同一入口列出 Mac、Omarchy 的已验证身份与 Workspace                |
| 三条跨设备询问      | 本机→Mac、本机→Omarchy、Omarchy→本机均返回目标设备独有的随机文件标记                            |
| 真实 Runtime 工具   | Pi 会话记录包含成功的 `exec_command` 工具结果；标记未出现在提问中                               |
| 同名 Workspace 隔离 | 三台 Workspace ID 均为 `facts`，返回标记与指定设备匹配                                          |
| 调用侧重启          | 本机 daemon 重启后，向 Mac 追问仍返回先前标记，无须重新读取文件                                 |
| 回答侧重启          | 重新发现 Peer 后，Omarchy→本机的历史追问通过；Omarchy 手动重启后的历史追问也通过                |
| 跨 Peer 并发        | 本机向 Mac、Omarchy 发起独立请求，均成功；向 Omarchy 发送取消时，Mac 的独立请求成功             |
| 单 Peer 离线        | 停止 Omarchy 后，`list_peers` 整体成功，Mac 为 `available: true`，Omarchy 为 `available: false` |
| 不存在的 Peer       | 返回 `PEER_NOT_FOUND`，未改投其他 Peer                                                          |

三个首次成功的文件读取，以及上述历史追问，探针均得到：

```json
{ "isError": false, "answered": true, "expectedMatched": true }
```

重启后曾有一次反向询问返回 `PEER_UNAVAILABLE`；显式重新发现 Peer 后，新发起的历史追问成功。这不能视为在途请求透明恢复。

## 未通过或待确认

### 1. Workspace 错误码不符合合同

本机经 Mac Peer 调用 `ask`，指定不存在的 Workspace：

```json
{ "isError": true, "code": "RUNTIME_FAILED", "answered": false, "expectedMatched": null }
```

期望为 `WORKSPACE_NOT_FOUND`。需要补双跳错误传播回归，再修复错误边界；本轮未修复。

### 2. 取消后的退出和自动恢复未验收

在 Omarchy 会话记录出现 `sleep 60` 工具调用后，探针发送 MCP 取消，客户端收到取消。随后向该 Peer 发起的新请求在 135 秒处失败：

```text
McpError: MCP error -32001: Request timed out
```

检查时 Omarchy 的测试 daemon 已退出。本轮未采集退出码和精确退出时刻，不能确定是否为规范允许的取消超时保护退出。前台运行也没有系统服务自动拉起。

手动重启后，两台 Peer 再次可用，Omarchy 的历史追问成功。**手动恢复通过，不等于取消收敛、在途请求不重试或系统服务自动恢复通过。**

### 3. 退出后的 Connector 残留

停止本机 daemon 后，进程快照中的两个 `qujing-transport connect` 仍在运行，已由系统父进程接管。通过 `/proc/PID/exe` 核对，两者均属于本轮测试构建，而非用户原有服务。

已分别发送 `SIGTERM` 并确认退出。需要验证 Scope、连接关闭和子进程释放顺序，补真实进程回归。

## 环境与探针修正

以下修正仅作用于本轮临时验收环境，不属于业务源码修复：

- Mac 的 Pi 在普通环境下 `get_state`、`set_model` 成功；继承 Qujing 测试 XDG 目录时，握手超时。测试 Runtime 启动器恢复宿主原环境，Qujing 配置仍隔离。
- SSH 非交互环境未加载宿主交互终端的代理。初次 Omarchy 模型请求超时；恢复原终端环境后成功。未修改宿主 Pi 模型默认值、认证或扩展配置。
- Tailcat 在本机代理环境中获取 DERP map 曾返回 `EOF`；测试传输启动器仅对传输进程移除代理变量，模型仍使用宿主代理。跨设备 MCP 流量由 Tailcat 承载，不经 SSH 隧道。
- 探针最初只调用 `Client.close()`，留下 HTTP MCP session 并触发容量限制。改为先调用 `StreamableHTTPClientTransport.terminateSession()`，重启测试调用端清除旧 session 后继续。未调整产品容量限制。
- 三条配对文件由用户通过现有 SSH 别名执行私密传输；验证远端身份、导入成功后删除源端和接收端配对文件。

## 仓库检查

| 命令                                           | 结果                                                                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `bun run verify`                               | 通过：Bun 两组共 158 测试、Effect 17 测试；格式、lint、类型检查和 Go 测试通过                                    |
| `bun run test:transport:e2e`                   | 原命令失败：本机缺 `/bin/zsh`                                                                                    |
| 临时 Bash 等价执行                             | GNU `stat -f` 的输出污染权限断言；仅在内存中改为 GNU `stat -c`，并对传输进程移除代理后，输出 `transport e2e: ok` |
| `bun run build:release all`                    | Windows 打包阶段缺 `zip`，整体失败                                                                               |
| `bun run build:release darwin-arm64 linux-x64` | 通过，供本轮三台使用                                                                                             |

临时适配后的传输检查通过，不代表仓库原始 E2E 命令已通过；两个目标构建通过，也不代表全平台发布检查通过。

## 清理与后续

三台测试 daemon 已停止，测试端口已关闭，进程快照中的存活进程已清理；测试目录、凭据、配对文件及 Workspaces 已删除。宿主全局 Pi 会话归档保留。Mac 原有 `com.qujing.gateway` 服务未停用，清理后仍为原 PID，原有 Qujing 配置未改动。

后续需先修复错误码和 Connector 清理，确认取消退出原因，再补跑：

1. 取消有界收敛、已接受请求不重试的完整证据。
2. macOS launchd、Linux systemd 安装、自动重启、移除与终端退出后的存活。
3. 凭据轮换、撤销、本机 bearer 拒绝测试。
4. 第二 Runtime 后端的真实工具、取消与历史恢复。

本报告不构成发布通过或生产部署就绪的结论。

## Effect-native 修复与本机复验（2026-09-07）

以下为后续源码修复及本机检查，不替代上面的三设备失败记录。

- `RuntimeCoordinator` 的预期业务错误改用 `Effect.fail`；`RuntimePool` 队列已满也走失败通道，不再成为 defect。真实双跳 HTTP MCP 回归确认不存在的 Workspace 返回 `WORKSPACE_NOT_FOUND`，空问题返回 `INVALID_QUESTION`，均未启动 Runtime；队列溢出可由 `Effect.catch` 收到 `BUSY`。
- `PeerRuntime` 对 MCP session 终止、SDK client 关闭各给 500ms；`Effect.ensuring` 保证前一步失败仍尝试 client 关闭，随后由 Scope 释放 Connector。真实子进程回归覆盖两种关闭挂起、PID 回收和端口关闭；另测忽略 SIGTERM 的 Connector 在原有 5 秒升级 SIGKILL 后被回收。未新增进程管理器或请求重试。
- 本机全局 Pi 0.84.4 原生 RPC 探针分别在 `exec_command`、`write_stdin` 开始时取消，`clear_queue` 至 `agent_settled` 约 31ms、20ms。探针随后主动终止 Pi，退出码 143 不是 daemon 保护退出证据。真实子进程 RPC 回归覆盖 abort 响应先到和 settled 先到，两种顺序均可取消后继续新问题。未复现原 Omarchy 故障，保留 5 秒取消收敛及 10 秒 fatal 关闭策略；远端退出原因和系统服务自动恢复仍未验收。
- Transport E2E 改用 Bash、Python 文件权限检查，消除 `/bin/zsh` 和 GNU/BSD `stat` 差异。
- 发布脚本在修改 `dist` 前校验目标和所需命令；自动回归确认非法目标、缺工具均提前失败。归档格式、安装器和 Formula 接口未变。

复验结果：

| 检查                                                                                                                 | 结果                                                                       |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `bun run verify`                                                                                                     | 通过，Bun 165 测试、Effect 17 测试，以及格式、lint、类型、Go 检查          |
| `env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy bun run test:transport:e2e` | 仓库脚本输出 `transport e2e: ok`；本轮无模型请求，仅为传输检查去除代理变量 |
| `bun run build:release darwin-arm64 linux-x64`                                                                       | 通过                                                                       |
| `bun run build:release all`                                                                                          | 未通过；提前报 `Missing release tools: zip. Install them and retry.`       |

清理复查又发现一个使用已删除旧验收二进制的本机 Connector（PID 185702），核对 `/proc/PID/exe` 后发送 SIGTERM；两台远端未发现旧验收进程。该进程来自修复前构建，不属于本轮回归。全平台发布、修复后三设备重跑与服务恢复仍待完成。

## Transport 重启恢复修复（2026-09-07）

后续复验中，E2E 曾在服务端重启后报 `curl: (56) Recv failure: Connection reset by peer`，再次运行通过。连续快速重启同一服务端、保留同一 Connector 的探针复现了 35 秒 bootstrap 超时；同期本机 HTTP 直连正常。单次 TCP 建连可以耗尽整个预算，使 bootstrap 循环无法再尝试。

`apps/cli/native/transport/main.go` 的 bootstrap 现为每次 Ping 与建连合计分配 8 秒，总预算仍为 35 秒。只有尚未进入 `ProxyConns` 的建连阶段可以再次尝试；未增加已转发请求重试，也未更换共享 Tailcat Client 或依赖版本。

仓库源码落地后的验证：

- `TestBootstrapRetriesStalledDialWithinTotalBudget` 使用 `testing/synctest`：原版首次建连耗尽预算而失败；修复后第二次建连成功。测试不等待真实的 8 秒。
- `go test -race ./...` 通过。旧 idle 回收测试对 `manager.peer` 的断言增加互斥锁，消除测试自身与 timer 回调之间的数据竞争。
- `bun run verify` 通过：182 个 Bun/Effect 测试，以及格式、lint、类型和 Go 检查。
- 去除代理变量后，`bun run test:transport:e2e` 通过。
- 使用仓库重新构建的 transport，同一 Connector 连续经历 5 次服务端重启，全部恢复；各轮耗时 16、15、17、17、17 秒。未修改现有系统服务。

另确认固定版本 Tailcat 的重复 `Ping` 会复用首次握手的已关闭 channel；服务端停止后也可能返回成功。隔离修改此行为仍未消除重启超时，因此本次未引入依赖补丁。上述通过结果限于本机传输重启恢复，不代表远端 Runtime 取消、系统服务恢复或全平台发布已通过。

## 结构清理复验（2026-09-07）

- `startManagedPiRpcSessionEffect` 在启动失败、中断或 defect 时通过 `Effect.onExit` 关闭尚未移交的 Scope；成功时仍由返回的 session 持有。真实子进程测试确认启动中断后 PID 已回收，回归在修改前失败、修改后通过。
- CLI 布尔参数集合从命令表派生，逐命令合法性校验保留。Node 与 Agent 的端口诊断共用 `doctor-shared.ts`，保留文案、结果顺序和原 `doctor.ts` 导出。
- Pi RPC、CLI、两组 Doctor 的 35 项相关测试通过。最终 `bun run verify` 退出 0：Bun 166 测试、Effect 17 测试，格式、lint、类型和 Go 检查通过，无 lint 警告。

发布前仍需使用最终源码重新构建发布包；全平台构建缺 `zip` 的阻塞未解除。远端取消退出原因、systemd/launchd 自动恢复及修复后三设备完整重跑仍未验收。第三方客户端超时配置的文档核对也不代表这些客户端已完成真实兼容性验收。

## 最新发布包与远端服务复验（2026-09-07）

本节更新前述待验状态；未覆盖的项目仍不视为通过。

### 发布构建

本机安装 `zip` 后，使用结构清理及文档校对后的源码运行 `bun run build:release all`，三个目标均完成。`SHA256SUMS` 全部通过；Windows zip 完整性、两个二进制和打包 Skill 内容通过检查。三个归档中的 README 与 setup Skill 均逐字节匹配当前源码。Linux 本机及 Mac 原生运行最新 `qj --version` 均输出 `0.1.2`。Windows 仅验证构建和归档，仍为 Preview。

### 服务与取消

两台远端分别使用隔离配置、Workspace 和端口。调用链为同一宿主上的 Agent MCP → 实际 Tailcat Connector → Node MCP → Runtime；配对文件只在该宿主生成、导入和删除，没有跨机器传输秘密。安装与移除调用当前 `service.ts` 实现，服务命令增加仅供验收的配置环境及退出记录启动器；Runtime 启动器恢复宿主 Pi 环境并只记录 RPC 事件类型和时间。未把这套隔离启动器作为产品默认配置。

| 宿主与场景                  | 观察结果                                                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Mac，Pi 0.85.1 正常取消     | 在真实 `write_stdin` 开始后取消，40ms 后收到 `agent_settled`；随后新问题成功，daemon 未退出                                       |
| Mac，注入不收敛 RPC         | 返回 `abort` 响应但不发送 `agent_settled`；daemon 在约5秒内以1退出，launchd 自动拉起，后续新问题成功；已接受的挂起 prompt 计数为1 |
| Omarchy，Pi 0.84.3 正常取消 | `clear_queue` 返回失败，daemon 以1退出；systemd 5秒后自动拉起                                                                     |
| Omarchy，注入不收敛 RPC     | daemon 在约5秒内以1退出；systemd 6秒后拉起，后续新问题成功；已接受的挂起 prompt 计数为1，服务累计 `NRestarts=2`                   |

退出日志采用秒级时钟，以上“约5秒”不是毫秒精度测量。服务在发起安装的 SSH 命令结束后仍运行；Omarchy 的 `Linger=no`，本轮不证明最后一个登录会话退出后仍运行。Mac 原有 `com.qujing.gateway` 未被替换或停止，PID 仍为2205。测试没有重跑此前的跨设备多 Peer 拓扑。

### Omarchy 原取消退出原因

独立运行宿主 Pi 0.84.3 的 RPC（不启动模型 turn）得到：

```json
{"id":"clear_queue","command":"clear_queue","success":false,"error":"Unknown command: clear_queue"}
{"id":"abort","command":"abort","success":true,"error":null}
```

因此原退出是取消清队列失败触发的保护退出，不是已证实的 Qujing 取消超时或重试故障。正常取消要求 Pi 支持 `clear_queue` 和 `agent_settled`；本机0.84.4、Mac0.85.1已观察到该能力。Omarchy 的兼容 Pi 复验仍待选择全局升级或临时版本；未擅自升级，也未绕过清队列合同。

两台测试服务已移除，测试 Runtime PID 均已消失，测试端口均已关闭，隔离配置、凭据、Workspaces 和下载目录已删除；宿主 Pi 会话归档保留。Mac `bootout` 返回后曾短暂仍可查询到正在退出的 job，随后确认 job、plist 与 launcher 均已移除；Omarchy 最终为 `LoadState=not-found`、`ActiveState=inactive`、`MainPID=0`。

### Omarchy 升级后闭环

经用户批准，使用 `mise upgrade github:earendil-works/pi --no-prune --yes` 将 Omarchy 全局 Pi 从0.84.3升级至0.85.1，保留旧安装。升级后及真实复验后，Pi settings/auth/models 文件哈希均与升级前一致，已有会话归档全部仍存在。

重新安装隔离测试服务后，在真实 `write_stdin` 执行中取消，19ms 后收到 `agent_settled`，随后新问题成功。再次注入不发送 `agent_settled` 的 RPC，daemon 以1退出，systemd 6秒后自动拉起；新问题成功，`NRestarts=1`，挂起 prompt 仅接受1次。测试服务、Runtime PID、端口及隔离目录随后再次清理完毕。

README 与 setup Skill 已补充 Pi 的 RPC 能力要求。文档更新后再次完成 `bun run build:release all`，三个归档 SHA256 校验通过；六个二进制的 SHA256 与远端验收使用的构建完全一致。至此，最新源码发布构建、兼容 Pi 的远端正常取消、两平台服务保护退出和自动恢复均已补齐。

本轮范围仍不包含 Windows 原生运行、最终构建的跨机器多 Peer 全矩阵复跑、所有第三方 MCP 客户端兼容性，以及 TanStack ACP 后端的全部真实工具验收。
