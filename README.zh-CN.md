# Colleague Line

[English](README.md) | **简体中文**

Colleague Line 让一个 MCP Agent 通过一个本机入口询问多位真实同事。每位同事运行一个 Owner Gateway，并手动注册自己的 Workspaces。询问方的 Client 为每位 Owner 私密保存一条 **Line**；只有 Agent 明确提供 Line 和 Workspace ID 时才路由请求。

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

## 最小安装流程

同一发布版本的 `colleague-line` 与 `colleague-line-transport` 必须放在同一目录。Owner 机器还必须能从 `PATH` 运行日常使用的全局 `pi` CLI。

### 1. 启动 Owner Gateway

```bash
colleague-line gateway init --owner-id jason --owner-name Jason
colleague-line gateway workspace add pi-tooling --name "Pi Tooling" --root ~/src/pi --summary "Pi SDK and extensions"
```

在独立 Owner 终端启动并保持 Gateway：

```bash
colleague-line gateway serve
```

### 2. 只初始化一次 Agent Client

```bash
colleague-line client init
```

在独立 Client 终端启动并保持 Client：

```bash
colleague-line client serve
```

`colleague-line client init` 只显示一次本机 bearer。Agent 只需配置一次：

- URL：`http://127.0.0.1:43111/mcp`
- Header：`Authorization: Bearer <local-bearer>`
- Timeout：至少 `135` 秒

### 3. 配对一条 Line

在 Client 机器生成 Line key：

```bash
colleague-line client line key-create jason
```

只把输出的 public key 发给 Owner。Owner 注册一个 remote Client identity：

```bash
colleague-line gateway client add alice-jason --tailcat-key 'nodekey:...'
```

Owner 命令只显示一次 remote bearer，同时输出 Tailcat address 和 port。通过可信渠道传给 Client，然后验证 Owner 并保存 Line：

```bash
printf '%s' '<remote-bearer>' | colleague-line client line add jason \
  --owner-id jason \
  --remote-client-id alice-jason \
  --server '<tailcat-address>' \
  --port 43110 \
  --key ~/.local/share/colleague-line/client/keys/jason.json \
  --bearer -
```

增加更多 Owner 时只重复第 3 步。Agent endpoint 和本机 bearer 不变。

完整安装、配对、轮换、撤销、服务和故障恢复流程见 [`skills/colleague-line-setup/SKILL.md`](skills/colleague-line-setup/SKILL.md)。

## 信任模型

- Gateway、Client 和临时 Connectors 只绑定 loopback；Tailcat 只转发 Gateway port。
- Agent 本机 bearer 与每条 Line 的 Tailcat key、remote bearer 均独立。
- Client 每次重建 upstream MCP session 都验证 expected Owner ID。
- Gateway 直接运行 Owner 的全局 `pi --mode rpc --approve`，使用默认模型、认证、settings、skills、extensions、builtin tools 和 `~/.pi/agent/sessions/`。
- 每个已配对 remote Client 因此获得 Owner-level Pi 能力，包括 shell、文件修改，以及 Pi 选择访问时的 Workspace 外内容。
- Runtime Session ID 仍按 remote Gateway Client 与 Workspace 隔离。撤销只删除绑定，不删除 Owner 的全局 Pi archive。
- Colleague Line 默认日志不记录凭据、地址、roots、问题、回答或文件内容。

## 运维

```bash
colleague-line gateway doctor
colleague-line client doctor

colleague-line gateway service install --yes
colleague-line client service install --yes
```

macOS/Linux 上两种角色使用独立 launchd/systemd 服务；Windows Preview 仅支持前台运行。排障时可运行 `colleague-line gateway serve` 或 `colleague-line client serve`。

## 源码仓库

```bash
bun run verify
bun run test:transport:e2e
bun run build:release all
```

Tailcat 默认使用官方 best-effort DERP；只有实测需要时才增加私有 DERP。
