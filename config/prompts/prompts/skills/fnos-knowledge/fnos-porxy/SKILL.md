---
name: fnos-porxy
description: 管理 fnOS Hermes 应用出站代理。用户询问代理配置、协议、地址端口、启停、连通性测速或更新是否走代理时使用。通过 hermes fnos-proxy 协调应用私有服务，不与官方 hermes proxy OAuth 反向代理混淆。
---

# 应用出站代理

先运行 `hermes fnos-proxy status`。查询无写入。只报告实际返回的配置和启用状态，不打印或索取已有密码明文。

只在用户明确要求配置时运行 `configure`。配置、启停前简要说明会改变面板外部请求路由，并可能短暂重启正在运行的 Gateway。不要因一次网络失败擅自配置、启用或关闭代理。

## 命令

```sh
hermes fnos-proxy --help
hermes fnos-proxy status
```

仅当用户确认代理位于本机 7890 端口、使用 HTTP 且不需要认证时，才使用以下示例；否则使用用户指定的真实协议、主机和端口，不探测或猜测账号：

```sh
hermes fnos-proxy configure --stdin <<'JSON'
{"protocol":"http","host":"127.0.0.1","port":7890,"username":"","password":"","noProxy":"localhost,127.0.0.1,::1"}
JSON
```

`configure --stdin` 只接受一个 UTF-8 JSON 对象，最多 **16 KiB**，15 秒内结束输入。不接受其他配置参数或命令行密码。

| 字段 | 含义 |
|---|---|
| `protocol` | 小写 `http`、`https`、`socks5`、`socks5h`；HTTPS 指到代理服务器的 TLS 连接，SOCKS5h 在代理端解析目标域名 |
| `host` | 主机名或 IP，不含协议、路径或认证信息 |
| `port` | JSON 整数，1–65535，使用用户确认的端口 |
| `username` | 字符串；不含冒号及控制字符，最多 255 UTF-8 字节 |
| `password` | 字符串；不含控制字符，最多 255 UTF-8 字节；非空密码需要用户名 |
| `noProxy` | 逗号分隔的主机/IP，可带端口或使用 `.example.com`、`*.example.com`；`*` 表示全部绕过，谨慎使用，不支持 CIDR |

首次保存须给出主机和端口。省略协议时为 HTTP，认证为空，`noProxy` 为 `localhost,127.0.0.1,::1`。后续保存合并字段：**省略密码保留旧密码，`"password":""` 清除密码**。清除认证时同时把用户名和密码设为空字符串。不要在 JSON 中加入 `enabled`。

密码只能通过 stdin 传入，不放入 argv、URL、命令行内联 JSON、终端回显、日志或聊天回复。含真实密码时不要使用会进入 shell 历史的 heredoc。使用用户明确提供的私密输入渠道，例如已存在且权限为 0600 的 JSON 文件进行输入重定向，不展示文件内容。状态仅有 `passwordConfigured`，没有密码。

**保存不等于启用**。首次保存仍关闭；修改已有配置保留原启用状态。启停是独立操作，关闭保留配置：

```sh
hermes fnos-proxy enable
hermes fnos-proxy status
hermes fnos-proxy disable
```

以上命令按用户意图分别执行，不要把启用、关闭当作连续操作脚本。

## 测试与更新核实

使用用户指定或同意的无凭据 HTTP(S) URL，不在 URL 中放令牌或其他秘密：

```sh
hermes fnos-proxy test https://example.com/
hermes fnos-proxy test https://example.com/ --download
hermes update --status
```

- 测试使用**已保存的代理**，无需启用，并刻意忽略 `noProxy` 来验证代理。不会更改启用状态。非 2xx、认证失败、超时等返回非零退出码，不跟随测试 URL 的重定向。
- `timings` 是本次请求各阶段耗时（毫秒），`tcpMs` 包含 DNS。未发生的阶段可能为 `null`。`--download` 额外返回实际 `bytes`、`durationMs`、`bytesPerSecond` 和是否触及大小上限 `limited`。当前下载上限 8 MiB，服务端测试默认 15 秒，CLI 请求总等待上限 30 秒。
- 速度仅代表该代理到该 URL 的本次实际传输，不是整网带宽，不把连通性测试当速度测试。
- 查看 `hermes update --status` 的 `job.proxyMode` 核实**本次更新任务**选用的模式。`proxy`/`direct` 分别表示代理/直连，`null` 或 `unspecified` 不能证明已走代理。它是任务记录，不是当前开关，也不能证明每个目标都走代理（还受 `noProxy` 影响）。

## 边界与失败处理

- 启用后，面板的渠道扫码、远程模型列表/连接检测、应用版本查询、Git 初始化/更新，以及 Telegram Bot 连接使用统一代理。不会按国内域名自动直连，分流交给代理服务器。默认 `noProxy` 只保留本机服务。不是系统 VPN，不接管用户打开的外部网页或任意插件流量，也不改写用户模型配置和密钥。
- 面板地址输入支持 `http://host:port`、`https://host:port` 和 `host:port` 自动解析。CLI JSON 仍分别提供 `protocol`、`host`、`port`。
- 保存或启停最多等待 120 秒应用到 Gateway。手动停止的 Gateway 不会被自动拉起。若返回 `committed: true`、`gateway_restart_failed: true`，配置已保存且面板请求已使用新配置，但 Gateway 未完成应用，CLI 返回非零。先查状态再手动重启，不重复写入配置。
- 现有 `.env` 的 `TELEGRAM_PROXY` 或其他代理覆盖可能导致启用失败。不会自动删除或覆盖这些配置。
- 代理失败不静默回退直连。不要为了成功而关闭代理重试、修改 `.env`、全局 Git 配置、权限或自行安装 VPN。
- 所有操作均由当前应用用户访问私有 Unix socket，经同一服务协调。无需 monitor token。监控器未启动时报告失败，引导按正常应用流程恢复，不直接改代理文件或绕开服务。
- 运行任务期间修改或测试可能收到 **HTTP 409**。等任务完成后查询状态。若仍冲突，检查配置/环境冲突。不要自动循环重试、反复重放写请求。超时后结果不确定，先查状态再决定是否重试。
- 官方 `hermes proxy` 是 OAuth **反向代理**，不是这里的出站代理。不以其替代 `hermes fnos-proxy`，也不改写它的参数。
