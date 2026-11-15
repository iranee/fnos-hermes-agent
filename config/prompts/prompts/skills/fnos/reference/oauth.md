# OAuth 参考

## 固定参数

- `client_id`: `YJNMPJUGA9`
- `scope`: `trim.user.all trim.file.read trim.file.write trim.download.all trim.appcenter.all trim.photo.all trim.system.all trim.log.all trim.storage.all trim.docker.all`；产品专属 scope 见对应 reference
- `code_challenge_method`: `S256`
- `device_model`: `CLI`；设备名称规则见下文。
- 授权 code 有效期：5 分钟

## 登录

```bash
fnos-cli --profile home --host <host> --port <port> login --authorize-only --agent-name '<agent>'
fnos-cli --profile home --host <host> --port <port> login --code '<code>'
```

Agent 默认使用两段式授权，用户不必运行终端：

1. 确认用户指定的 NAS 和 profile；已有有效 session 时直接复用。新目标未知时先询问。
2. Agent 按下述规则提供自身名称，执行 `login --authorize-only --agent-name '<agent 名>'`，把返回的 `authorization_url` 原样作为链接发给用户。
   `authorization_pending=true` 仅代表等待授权，不是已登录；此命令不等待终端输入。
3. 用户自行打开链接、输入账号密码、确认授权，并把页面显示的一次性 code 发回当前 Agent。
4. Agent 收到用户明确提供的 code 后，用同一执行主机、系统用户、配置目录、profile 和连接参数
   执行 `login --code '<code>'`。code 作为独立参数传递；使用 shell 时正确引用，不拼接为 shell 语法。
5. 确认 `token_persisted=true`、`refresh_token_persisted=true`，再用同一 profile 执行
   `system info` 等只读请求，成功后才报告已连接并继续用户任务。

### 授权设备名称

首次发起授权时，Agent 只需通过 `--agent-name` 传入当前工具的简短名称，例如 Codex 用 `codex`、Claude 用 `claude`。名称为 1–32 个 ASCII 字母、数字或连字符，首字符须为字母或数字；CLI 自动转为小写。无法确认 Agent 身份时，先向用户确认名称。

CLI 在 macOS、Linux 和 Windows 上通过系统接口读取实际执行环境的主机名，保留其大小写，拼成 `{本机名}-{agent 名}`，例如 `macbook-codex`。无需 Agent 读取或猜测主机名，也不依赖 shell 命令或主机名环境变量。SSH/容器中使用该执行环境的主机名。本机名最多保留前 20 个字符（Unicode 标量值，非字节），Agent 后缀完整保留；例如 `abcdefghijklmnopqrstuv` 与 `codex` 组合为 `abcdefghijklmnopqrst-codex`。

名称会展示在 NAS 授权管理中，并保存在当前 profile 的待授权记录；`login --code` 自动复用，无需再次提供名称。`--agent-name` 不能与 `--device-name`、`--code` 或 `--refresh` 同用。系统主机名读取失败时，可由用户指定完整的 `--device-name`（非空、无控制字符、输入最多 128 UTF-8 字节；CLI 去除首尾空白）。手动登录省略两种参数时默认为 `fnos-cli`；新名称用于本次授权，不主动重命名历史授权。

### 授权注意事项

Agent 不代填账号密码、不自动点击授权、不读取浏览器页面 code；仅处理用户主动发来的 code。
code 会经过聊天和工具调用记录，也可能在本机进程参数中可见；它是敏感的一次性凭据，不能承诺
聊天侧不留存。不要在回复中复述、额外写文件/日志、开启 shell trace 或转发给其他人。
access/refresh token 和 PKCE verifier 留在 CLI 的存储中，不读取或发送到聊天。
若设备启用安全访问码，token 兑换响应的 `x_access_code` 也由 CLI 保存在同一 profile 的受控 session 中；
Agent 不接收、不复述此值。该响应值已编码，CLI 会原样用作请求头，不再编码。CLI 对后续受保护 HTTP 请求自动附加 `X-Access-Code` 与
`X-Access-Source: app`，不发送 `x-device-id`。浏览器中的访问码页面仍由用户自行完成。

授权 URL 包含 PKCE challenge、client、scope 和 device 参数，不包含 `redirect_uri`，不要自行
改写。每个 profile 只保留一个 pending verifier；等待 code 期间不要再次生成链接，否则会覆盖
原 pending。两个命令均显式保持相同 host/port/scheme/TLS 选项；新 session 尚未保存时，不能
依赖默认目标。远端明文 HTTP 两步都需要 `--scheme http --allow-insecure-http`。

目标为已支持的 Connect 设备子域名时，CLI 对目标的 OAuth 和代理 HTTP 请求自动附加
`mode=relay` Cookie；其他目标不附加。此 Cookie 只用于 CLI 发出的请求，
不改变用户在浏览器中打开的授权链接。

code 只能交换一次，有效期 5 分钟。pending 过期、丢失、目标不匹配或 code 交换失败时停止，
解释原因并重新发起授权，不循环重试旧 code；若响应表明 token 已保存而用户摘要/探测失败，
先检查现有 session 的只读调用，不再次交换已消费的 code。多个并行授权使用不同 profile。
两步都使用 Skill 提供的同包启动器，不需要交互 TTY；切换 Host/SSH/容器时须在实际执行
环境重新授权，不能假定本机 session 自动共享。macOS Keychain 可能需要用户批准系统提示。

用户主动选择手动终端时仍可运行普通 `login`，在 CLI 提示中输入 code；`--no-open` 仅关闭
自动打开浏览器，不改变这条手动流程。Agent 默认流程不要求用户打开终端。
`trim.basic` 不属于当前可申请列表，CLI 不显式申请。旧的 `file photo` scope 或缺少当前模块
所需 scope 的 session 不再兼容，必须重新登录；refresh token 不能用来扩展原授权范围。

## 刷新授权

```bash
fnos-cli --profile home login --refresh
```

命令开始前 access token 在 60 秒内过期会自动 refresh。代理 `/ogh/ac/w` 或原生 HTTP
`/ogh/ac/h/*` 返回 401 时，CLI 按 profile 加锁 refresh 并只重试一次；第二次仍 401 时停止。
refresh 返回新 refresh token 时替换旧值，未返回时保留旧值。刷新前 CLI 会把当前 session 原值
写回当前 profile，确认真实存储目标可写；预检失败时不会发送 refresh 请求，因此不会消耗可能轮换的 refresh token。
`ask-file` 的存储选择只会询问一次，并沿用到本次刷新提交。多进程获得锁后会重新读取 session，
已被其他进程刷新时直接使用新 token，不覆盖较新的 session。
refresh 不轮换设备安全码，CLI 在请求中携带已保存的访问码头，并在更新 OAuth token 时保留安全码。
响应带 `x-trim-safe-code-challenge` 时按设备访问码拦截处理，不触发 OAuth 401 refresh。HTTP 429 表示验证受限，应等待后重试；503 表示验证服务不可用；403 可能是策略拒绝或临时封锁。网关返回 200 挑战页时无法进一步判定原因，CLI 提示重新登录取得有效码。

存储仍可能在请求发出后失效。若 refresh 成功但最终 session 写入失败，不要反复使用旧 refresh
token；服务端可能已完成轮换，应重新发起上述 OAuth 授权。

## 登录状态与退出

session 保存 access/refresh token、可选设备安全码、过期时间、OAuth client/device/scope 和用户摘要。
`logout` 清理当前 profile 的 session 和 pending 文件，不承诺远端撤销令牌。

需要重新登录时走上述授权流程，不回退到 CLI 用户名密码、2FA 或旧 token 恢复。只有用户
回传的 code 可用于 `login --code`；code verifier、access token 和 refresh token 不放进命令参数，
也不输出到聊天或日志。

## 新版升级

本产品仅使用 `FNOS_CLI_*` 配置变量并保存独立登录状态。升级后重新授权；不迁移、读取或删除旧登录数据。其他产品的同名 profile 不共享状态。
