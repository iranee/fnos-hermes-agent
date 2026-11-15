# SOUL.md — Hermes Agent 运行环境

> 描述本应用运行环境。行为准则与技能索引见 AGENTS.md。以当前用户请求、官方工具定义和授权边界为准。

---

## fnOS 运行环境

Hermes Agent 以 `fpk` 应用形式安装在 fnOS 上，以应用用户 `hermes-agent` 身份运行。fnOS 是基于 Debian 深度定制的 NAS 系统，行为与标准 Debian 有大量差异，以实际表现为准。

要点：
- 存储根目录是 `/vol<N>/`，卷号由安装时决定，不假设 `vol1`。
- 用户/存储/网络/防火墙由 WEB UI 管理。`/usr/trim/`、`/etc/fnos/`、`/etc/docker/daemon.json` 由 fnOS 管理，不要 CLI 直改。
- API 连接必须用 NAS 真实内网 IP，不能用 `127.0.0.1`（指向 nginx 反代）。

---

## Hermes Agent 运行时

```
venv:      $TRIM_PKGHOME/data/venv（Python 3.14）
hermes:    $TRIM_PKGHOME/data/venv/bin/hermes
Monitor:   Unix socket（$TRIM_APPDEST/hermes-agent.sock），无管理 TCP 端口
Gateway:   官方渠道与 WebApp 的共同服务进程
WebApp:    127.0.0.1:9120，经 /app/hermes-agent/webapp/ 访问
Dashboard: 9119，手动启停，经 /app/hermes-agent/dashboard/ 访问
```

### 目录别名对照（同一物理路径有多个别名，操作前先对齐）

| 环境变量 | 绝对路径 | 等价路径 | 用途 |
|----------|----------|----------|------|
| `$TRIM_PKGHOME` | `/vol<N>/@apphome/hermes-agent` | `/var/apps/hermes-agent/home` | 持久数据（config、venv、.env、sessions、skills） |
| `$TRIM_PKGVAR` | `/vol<N>/@appdata/hermes-agent` | — | 运行时数据（logs、pid、token） |
| `$TRIM_APPDEST` | `/var/apps/hermes-agent/target` | `/vol<N>/@appcenter/hermes-agent` | 程序文件（cmd 脚本、socket） |
| 共享文件夹 | `/vol<N>/@appshare/hermes-agent` | `/var/apps/hermes-agent/share/hermes-agent` | 用户可在文件管理器看到 |

`$TRIM_PKGHOME/data/`（即 `$HERMES_HOME`）= `/vol<N>/@apphome/hermes-agent/data/` = `/var/apps/hermes-agent/home/data/`，Hermes 的 `.env`、`config.yaml`、`skills/`、`weixin/accounts/` 都在这里。

- TRIM_* 变量由 fnOS 提供，SSH 会话不一定有。缺失时先确认当前应用路径。
- 升级走 fnOS 应用中心覆盖安装，`$HERMES_HOME` 原地保留，不迁移不清空。
- Monitor token 在 `$TRIM_PKGVAR/monitor.token`（镜像 `$TRIM_PKGHOME/data/.monitor_token`）。

---

## 语言

默认中文。前 3 轮内按用户使用语言自动切换并保持。技术专有名词（API Key、OAuth、JSON、skill 等）保留英文。生成的日志、文件、skills 内容使用用户偏好语言。
