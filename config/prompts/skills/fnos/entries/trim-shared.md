---
name: trim-shared
description: 登录、选择连接目标或 profile、排查登录状态和连接问题，以及应用通用安全规则时使用。
---

# 连接与授权

先读[主入口](../SKILL.md)与[使用索引](../reference/_index.md)；登录前完整阅读 [OAuth 指南](../reference/oauth.md)。

## 规则

- 默认回环目标是 `http://localhost:5666`。全局 `--profile <name>` 选择独立登录状态。
- `--scheme auto` 且未显式指定端口时，回环使用 `http:5666`，远端 IP 使用 `https:5667`，远端域名使用 `https:443`。显式 `--port` 优先，CLI 此时只推导 scheme。
- 未传连接选项时恢复当前产品、当前 profile 已保存的 host、port、scheme 与 TLS 设置；登录写入与退出清理也只影响该产品/profile。
- 新版必须重新授权。旧凭据保留，不读取或迁移；用户配置仅使用 `FNOS_CLI_*`。
- 已支持的 Connect 设备子域名请求自动包含 `mode=relay` Cookie；其他目标不附加。具体设备或连接路径需实际验证。
- 自签 HTTPS 可能需要显式 `--tls-insecure`；远端明文 HTTP 需要显式 `--allow-insecure-http`。
- 默认使用平台安全存储。`FNOS_CLI_SESSION_STORAGE=file` 仅适用于隔离测试或 CI。安全存储失败后，显式 `FNOS_CLI_SESSION_STORAGE=ask-file` 会询问是否回落到较低信任的文件存储。
- OAuth PKCE 由用户在浏览器中处理凭据和 2FA。Agent 先传入自身简短名称（如 `codex`），CLI 自动拼接执行环境的主机名作为设备授权名。Agent 分别执行 `login --authorize-only --agent-name '<agent>'` 与 `login --code`，等待用户主动回传 code，无需用户终端。
- 两步和后续请求保持同一执行主机、系统用户、配置环境、profile 与目标。SSH、容器和远端浏览器不自动共享登录态；macOS 后台 Keychain 访问可能需要系统批准。
- access token 临近到期会刷新；`login --refresh` 可主动刷新。刷新先检查存储可写性，失败则不发送请求；并发进程复用较新状态，避免覆盖轮换后的 token。
- token 交换返回的设备访问码保存在受控 session 中，并在受保护请求自动附加所需请求头。不要求用户把设备访问码发到聊天；网关挑战要求重新登录。
- 连接失败应显示当前尝试的 `host:port`。profile 名不能为空，仅允许 ASCII 字母、数字、`_`、`-`、`.`。
- 输入校验拒绝控制字符、空值和超长内容，不静默改写。
- `raw` 只对内置审计过的只读端点免除 `--yes`；其他及未知端点均需要确认，不能仅凭名称判断只读。

## 命令

Agent 分别执行两步登录，中间等待用户 code，保持目标和 profile 一致：

```bash
fnos-cli --profile home --host <host> --port <port> login --authorize-only --agent-name '<agent>'
fnos-cli --profile home --host <host> --port <port> login --code '<code>'
fnos-cli --profile home system info
```

仅在用户任务需要时使用以下命令，不把它们当作首次连接必做步骤：

```bash
fnos-cli --profile home raw appcgi.system.getInfo --json '{"language":"zh-CN"}'
fnos-cli --profile home raw appcgi.network.ssh.switch --json '{"enable":true}' --yes
fnos-cli --profile home logout
```
