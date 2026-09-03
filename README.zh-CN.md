# 取经（Qujing）

[English](README.md) | **简体中文**

取经让一个 MCP Agent 通过一个本机入口询问多位真实同事。每位同事运行一个 Owner Gateway，并手动注册自己的 Workspaces。询问方的 Client 为每位 Owner 私密保存一条 **Line**；只有 Agent 明确提供 Line 和 Workspace ID 时才路由请求。

```text
Agent → 本机 Client MCP → 指定 Line/Tailcat → Owner Gateway → Pi → Workspace
```

没有自动路由、共享知识索引、公开 Gateway，也不要求 Agent 为每位 Owner 分别配置 MCP Server。

> **平台：**支持 macOS Apple Silicon 与 Linux x64。Windows x64 发布包仍为 **Preview**，等待原生验收。

## Agent-facing MCP

Client 在 `/mcp` 只暴露两个 Streamable HTTP 工具：

- `list_lines()` 返回每条 Line 的可用性、已验证 Owner metadata 和公开 Workspace metadata。
- `ask({ line, workspace, question })` 通过一条指定 Line 询问一个指定 Workspace。

Agent 使用一个本机 bearer 认证。MCP tool-call timeout 至少设为 **135 秒**。Owner Gateway 内部的 `list_workspaces()` 与 `ask({ workspace, question })` 不直接配置给 Agent。

## 角色

- **Owner（部署方）**运行 Gateway、Pi Runtime 和 Workspaces。
- **Client（接入方）**运行一个本机 MCP 服务，并私密管理通往多位 Owner 的 Lines。
- **Agent（调用方）**默认只连接 `http://127.0.0.1:43111/mcp`。

同一台机器可以同时承担 Owner 和 Client，但两种角色的命令、配置、锁和服务彼此独立。

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

两种安装方式都会配套安装同一发布版本的 `qj` 与 `qujing-transport`。Owner 机器还必须能从 `PATH` 运行日常使用的全局 `pi` CLI。

### 1. 启动 Owner Gateway

```bash
qj init gateway --owner-id jinjiebewater --owner-name JinJieBeWater
qj workspace add pi-tooling --name "Pi Tooling" --root ~/src/pi --summary "Pi SDK and extensions"
```

在独立 Owner 终端启动并保持 Gateway：

```bash
qj serve gateway
```

### 2. 只初始化一次 Agent Client

```bash
qj init client
```

在独立 Client 终端启动并保持 Client：

```bash
qj serve client
```

`qj init client` 只显示一次本机 bearer。Agent 只需配置一次：

- URL：`http://127.0.0.1:43111/mcp`
- Header：`Authorization: Bearer <local-bearer>`
- Timeout：至少 `135` 秒

如果 Client 已初始化但本机 bearer 丢失，运行 `qj token rotate`，然后替换 Agent 保存的 bearer。

### 3. 配对一条 Line

在 Client 机器生成 Line key：

```bash
qj line key-create jinjiebewater
```

只把输出的 public key 发给 Owner。保持 Gateway 运行，由 Owner 注册一个 remote Gateway Client identity：

```bash
qj pair create alice-jinjiebewater \
  --key 'nodekey:...' \
  --out ./alice-jinjiebewater.pairing.json
```

通过可信渠道把私密 pairing bundle 传给 Client。Client 默认使用为 `jinjiebewater` 创建的 key，验证 Owner 后保存 Line：

```bash
qj pair accept jinjiebewater --from ./alice-jinjiebewater.pairing.json && rm ./alice-jinjiebewater.pairing.json
```

Client 确认导入后，Owner 也要删除源文件 `alice-jinjiebewater.pairing.json`。bundle 包含一次显示的 remote bearer 和 Tailcat 坐标；必须私密传输，导入后删除源文件、传输副本和中间副本。省略 `--out` 会向 stdout 输出 JSON；`--from -` 可从 stdin 导入。

增加更多 Owner 时只重复第 3 步。Agent endpoint 和本机 bearer 不变。

需要 Agent 执行安装、配对、验证、凭据轮换、升级或故障恢复时，使用 [`skills/qujing-setup/SKILL.md`](skills/qujing-setup/SKILL.md)。

## 信任模型

- Gateway、Client 和临时 Connectors 只绑定 loopback；Tailcat 只转发 Gateway port。
- Agent 本机 bearer 与每条 Line 的 Tailcat key、remote bearer 均独立。
- Client 每次重建 upstream MCP session 都验证 expected Owner ID。
- Gateway 直接运行 Owner 的完整全局 `pi --mode rpc --approve`，使用默认模型、认证、settings、skills、extensions、builtin tools 和 `~/.pi/agent/sessions/`。
- 取经只附加固定咨询提示词，引导 Pi 按问题获取相关上下文并保持只读行为；它不替换或过滤 Owner 的 Pi 配置。提示词是行为指导，不是安全边界。
- 每个已配对 remote Gateway Client 因此获得 Owner-level Pi 能力，包括 shell、文件修改，以及 Pi 选择访问时的 Workspace 外内容。
- Runtime Session ID 仍按 remote Gateway Client 与 Workspace 隔离。撤销只删除绑定，不删除 Owner 的全局 Pi archive。
- 取经默认日志不记录凭据、地址、roots、问题、回答或文件内容。

## 运维

```bash
qj doctor gateway
qj doctor client

qj service install gateway --yes
qj service install client --yes
```

macOS/Linux 上两种角色使用独立 launchd/systemd 服务。macOS 后台项目显示 `qujing-gateway` 或 `qujing-client`，终端命令仍是 `qj`。Windows Preview 仅支持前台运行。排障时可运行 `qj serve gateway` 或 `qj serve client`。

## 源码仓库

```bash
bun run verify
bun run test:transport:e2e
bun run build:release all
```

Tailcat 默认使用官方 best-effort DERP；只有实测需要时才增加私有 DERP。
