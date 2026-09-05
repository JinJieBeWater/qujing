# 增加 PeerDirectory seam，但不做网络 discovery

Qujing 需要把“可见的 Peer 候选”与“已认证可询问的 Peer Link”分开。`PeerDirectory` 是 local Node 内部 seam，只返回候选 Peer metadata；`ask({ peer, workspace, question })` 仍必须命中已配对、已认证、Workspace 可用的 Peer Link。

MVP 只提供两个实现：

- empty directory：没有候选；
- manual directory：用户手工录入 Peer ID、name、summary 和可选 hints。

不做 central registry、LAN scan、broadcast、DHT、public search、auto-pairing、ranking、routing 或旧拓扑导入。

## 后果

- `list_peers()` 可以展示未配对候选，但这只降低人工配对前的辨识成本。
- Discovery 不等于 authorization；pairing bundle、Tailcat key、remote bearer 和 Node handshake 仍是唯一 ask 准入路径。
- Seam 留出未来替换点，但当前没有网络发现、后台同步或索引存储。
