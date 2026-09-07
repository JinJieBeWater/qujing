# 取经（Qujing）

[English](README.md) | **简体中文**

取经让一个 MCP Agent 通过一个本机 Node 入口询问多位真实同事。每位同事都是一个 Qujing Node，并手动注册自己的 Workspaces。本机 Node 为每位已配对 Peer 私密保存一条 **Peer Link**；只有 Agent 明确提供 Peer 和 Workspace ID 时才路由请求。

```text
Agent → 本机 Node MCP → 指定 Peer Link/Tailcat → Peer Node → Runtime → Workspace
```

没有自动路由、共享知识索引、公开 Node、网络 discovery，也不要求 Agent 为每位 Peer 分别配置 MCP Server。

> **平台：**支持 macOS Apple Silicon 与 Linux x64。Windows x64 发布包仍为 **Preview**，等待原生验收。

## Agent-facing MCP

本机 Node 在 `/mcp` 只暴露两个 Streamable HTTP 工具：

- `list_peers()` 返回可见 Peer 候选，以及每个已配对 Peer 的可用性、已验证 Node metadata 和公开 Workspace metadata。
- `ask({ peer, workspace, question })` 通过一个指定 Peer 询问一个指定 Workspace。

Agent 使用一个本机 bearer 认证。Agent 不是 Peer。Discovery 只表示可见；`ask` 仍需要已配对 Peer credentials。MCP tool-call timeout 至少设为 **135 秒**。Node 内部的 `list_workspaces()` 与 `ask({ workspace, question })` 不直接配置给 Agent。

## 模型

- **Node** 是一个人控制的 Qujing identity。一个安装只有一个 Node identity。
- **Peer** 是本机 Node 可见的另一个 Qujing Node。Manual PeerDirectory 可列出候选；empty directory 不列出候选。
- **Agent（调用方）**默认只连接本机 Node 的 `http://127.0.0.1:43111/mcp`，不属于 Peer mesh。

一个 `qj serve` daemon 承载 local MCP、Peer-facing MCP、Runtime 和 Connector 资源。

## 安装

macOS Apple Silicon 或 Linux x64：

```bash
brew tap jinjiebewater/tap
brew trust --formula jinjiebewater/tap/qujing
brew install qujing
qj --version
```

Homebrew 6 对第三方 Tap 要求显式信任具体 Formula。也可以改用独立安装脚本：

```bash
curl -fsSL https://raw.githubusercontent.com/JinJieBeWater/qujing/main/install.sh | sh
export PATH="${QUJING_INSTALL_DIR:-$HOME/.local/bin}:$PATH"
qj --version
```

安装脚本会下载并校验匹配平台的 GitHub Release，然后把两个可执行文件安装到 `~/.local/bin`。可用 `QUJING_INSTALL_DIR` 更改目录。固定版本：

```bash
curl -fsSL https://raw.githubusercontent.com/JinJieBeWater/qujing/main/install.sh | QUJING_VERSION=v0.1.2 sh
```

Windows x64 Preview：

```powershell
irm https://raw.githubusercontent.com/JinJieBeWater/qujing/main/install.ps1 | iex
$installDir = if ($env:QUJING_INSTALL_DIR) { $env:QUJING_INSTALL_DIR } else { "$HOME\.local\bin" }
$env:Path = "$installDir;$env:Path"
qj --version
```

本机安全策略要求审查脚本时，先阅读 [`install.sh`](install.sh) 或 [`install.ps1`](install.ps1) 再执行。手动安装包和 `SHA256SUMS` 仍可从 [GitHub Releases](https://github.com/JinJieBeWater/qujing/releases) 下载。

### 让 Agent 协助配置

先按上文安装 Qujing 二进制，再给 coding Agent 安装仓库内的运维 Skill：

```bash
bunx --bun skills add "JinJieBeWater/qujing@v$(qj --version)" --skill qujing-setup --global --yes
```

使用固定版本或离线发布包时，在解压目录改用 `bunx --bun skills add ./skills/qujing-setup --global --yes`。然后告诉 Agent：`使用 qujing-setup 部署、配对或诊断 Qujing。` Skill 会按当前目标选择所需分支、验证可观察状态，并从报告中排除秘密。参与产品开发的 Agent 应读取 [`AGENTS.md`](AGENTS.md)。

## 最小安装流程

两种安装方式都会配套安装同一发布版本的 `qj` 与 `qujing-transport`。Node Runtime 可使用内置 Pi RPC，或配置好的 TanStack AI ACP harness。

Pi RPC 需要 Pi CLI 支持 `clear_queue` 和 `agent_settled`；已验证 Pi 0.85.1。Pi 0.84.3 缺少 `clear_queue`，不满足 Qujing 的取消合同。升级时保留宿主 Pi 设置、认证、扩展和会话归档。

### 1. 初始化 Node

```bash
qj init --node-id jinjiebewater --node-name JinJieBeWater
qj workspace add runtime-tooling --name "Runtime Tooling" --root ~/src/runtime --summary "Runtime SDK and extensions"
```

启动 Node 前配置 Runtime：

```bash
qj runtime set-pi --model openai-codex/gpt-5.5
```

`qj init` 只显示一次本机 bearer。Agent 只需配置一次：

- URL：`http://127.0.0.1:43111/mcp`
- Header：`Authorization: Bearer <local-bearer>`
- Timeout：至少 `135` 秒

如果本机 bearer 丢失，运行 `qj token rotate`，然后替换 Agent 保存的 bearer。

在独立终端启动并保持 Qujing：

```bash
qj serve
```

### 2. 配对一个 Peer

在本机 Node 机器生成 Peer Link key：

```bash
qj peer key-create jinjiebewater
```

只把输出的 public key 发给 Peer Node。保持 Node 运行，由 Peer Node 注册一个 remote Peer credential：

```bash
qj peer invite alice-jinjiebewater \
  --key 'nodekey:...' \
  --out ./alice-jinjiebewater.pairing.json
```

通过可信渠道把私密 pairing bundle 传给本机 Node。本机 Node 默认使用为 `jinjiebewater` 创建的 key，验证 Peer Node 后保存 Peer Link：

```bash
qj peer accept jinjiebewater --from ./alice-jinjiebewater.pairing.json && rm ./alice-jinjiebewater.pairing.json
```

本机 Node 确认导入后，Peer Node 也要删除源文件 `alice-jinjiebewater.pairing.json`。bundle 包含一次显示的 remote bearer 和 Tailcat 坐标；必须私密传输，导入后删除源文件、传输副本和中间副本。省略 `--out` 会向 stdout 输出 JSON；`--from -` 可从 stdin 导入。

增加更多 Peer 时只重复第 3 步。Agent endpoint 和本机 bearer 不变。

需要 Agent 执行安装、配对、验证、凭据轮换、升级或故障恢复时，使用 [`skills/qujing-setup/SKILL.md`](skills/qujing-setup/SKILL.md)。

## 信任模型

- Node MCP、Agent-facing MCP 和临时 Connectors 只绑定 loopback；Tailcat 只转发 Node port。
- Agent 本机 bearer 与每条 Peer Link 的 Tailcat key、remote bearer 均独立。
- 本机 Node 每次重建 upstream MCP session 都验证 expected Peer Node ID。
- Node Runtime 可用显式 `provider/model` 运行内置 Pi RPC，也可通过 `@tanstack/ai`、`@tanstack/ai-acp`、local process sandbox、TanStack persistence 和 TanStack locks 运行任意 ACP-compatible CLI。
- 取经只附加固定咨询提示词，引导 Runtime 按问题获取相关上下文并保持只读行为；它不替换或过滤 Runtime 配置。提示词是行为指导，不是安全边界。
- 每个已配对 Peer 因此获得 Node-level Runtime 能力，包括 shell、文件修改，以及 Runtime 选择访问时的 Workspace 外内容。
- Runtime Session ID 仍按 remote Peer credential 与 Workspace 隔离。撤销只删除绑定，不删除 TanStack transcript state。
- 取经默认日志不记录凭据、地址、roots、问题、回答或文件内容。

## 运维

```bash
qj doctor

qj service install --yes
```

macOS/Linux 上使用一个 launchd/systemd 服务。macOS 后台项目显示 `qujing-daemon`，终端命令仍是 `qj`。Windows Preview 仅支持前台运行。排障时可运行 `qj serve`。

## 源码仓库

发布构建需要 Bun、Go 和 `tar`；Windows 归档还需要 `zip`。缺少工具时会在修改 `dist` 前失败。Transport E2E 需要 Bash、Python 3 和 curl。

```bash
bun run verify
bun run test:transport:e2e
bun run build:release all
```

Tailcat 默认使用官方 best-effort DERP；只有实测需要时才增加私有 DERP。
