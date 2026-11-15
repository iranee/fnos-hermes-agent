---
name: trim-user
description: 查看用户、组、登录设备和当前权限，管理用户，或选择正确的已授权 profile。
---

# 用户与权限

阅读 `../reference/user.md` 和 `../reference/workflows/device-validation.md`。

## 使用规则

- 大多数设备操作需要已登录会话。
- 设备验收只使用当前 profile 的 OAuth 会话；切换身份时明确选择另一 profile。
- OAuth PKCE 登录把凭据和 2FA 留给用户，不能构造密码、2FA 或手工 access token 登录命令。
- 需要授权时先阅读 `../reference/oauth.md`。Agent 使用 `login --authorize-only --agent-name '<agent>'` 生成链接，用户在浏览器授权并回传一次性 code，再由 Agent 在同一环境、profile 和连接参数下执行 `login --code`。确认 token 持久化并完成只读请求后再继续。用户无需终端；只有用户明确选择时才使用交互式 `login`。
- 未封装的 `user.*` 端点使用 `user request`。用户及登录设备写操作默认需要确认，Agent 写操作明确传入 `--yes`。

## 授权步骤

```bash
fnos-cli --profile home --host <host> --port <port> login --authorize-only --agent-name '<agent>'
```

用户回传 code 后，按 OAuth 指引完成授权：

```bash
fnos-cli --profile home --host <host> --port <port> login --code '<code>'
```

以下是用户管理命令，不是登录步骤：

```bash
fnos-cli logout
fnos-cli user request user.checkNewUser --json '{"user":"<new-user>"}' --yes
```
