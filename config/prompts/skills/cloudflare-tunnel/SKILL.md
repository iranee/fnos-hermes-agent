---
name: cloudflare-tunnel
description: 用 Cloudflare Tunnel 把 NAS 上的本地 HTTP 服务（Hermes WebApp、Dashboard、用户自建服务）临时或固定地发布到公网。用户提到外网访问、公网链接、trycloudflare、隧道、cloudflared、让手机/外地访问 NAS 服务时使用。
license: MIT
metadata:
  tags: [cloudflare, tunnel, cloudflared, trycloudflare, 隧道, 外网访问, 公网]
---

# Cloudflare Tunnel（fnOS Hermes Agent）

通过 `cloudflared` 把 NAS 本地端口映射为公网 HTTPS 地址。两种模式：

- **Quick**：临时 `https://<随机>.trycloudflare.com`，免账号，重启即变。用于演示、临时分享、短期测试。
- **Named**：固定域名（如 `app.example.com`），需要 Cloudflare 账号 + 托管域名 + 在 Zero Trust 面板创建的隧道 token。用于长期映射、Webhook 回调。

## 目录与路径（全部在本技能目录内，统一管理）

```
$HERMES_HOME/skills/cloudflare-tunnel/
├── SKILL.md
├── scripts/tunnel_helper.py   唯一入口，所有操作都通过它
├── bin/cloudflared            二进制（install 子命令下载，或手动放入，mode 755）
├── state/                     pid / 公网地址 / 日志（quick.* 与 named.*）
└── references/                quick-tunnel.md、named-tunnel.md、security.md、troubleshooting.md
```

调用前固定这两个变量，后文命令都用它们：

```bash
CFT="$HERMES_HOME/skills/cloudflare-tunnel"
PY="$HERMES_HOME/venv/bin/python"; [ -x "$PY" ] || PY=python3
```

不要把 cloudflared 装到系统路径、不要把状态写到用户目录或 `/tmp`，升级应用时此目录保留。

## 开始前必须做的判断

1. 本地目标：端口或完整 URL。常用端口：Hermes WebApp `9120`、Dashboard `9119`，`8642` 是 Gateway 内部接口，不要对外发布。
2. 模式：用户说临时/演示/分享/没有域名 → Quick。说固定域名/长期/Webhook → Named，不明确时默认 Quick。
3. **敏感性**：WebApp 与 Dashboard 没有登录鉴权，发布后任何拿到链接的人都能操作模型与文件。发布这两个端口或任何含管理面板、私密数据、无鉴权写接口的服务前，先向用户说明风险并得到明确同意，详见 `references/security.md`。

## 第一次使用：准备二进制

```bash
"$PY" "$CFT/scripts/tunnel_helper.py" check
```

报 `cloudflared not found` 时自动安装（从 GitHub Releases 下载 linux-amd64/arm64，约 50 MB，走当前环境代理）：

```bash
"$PY" "$CFT/scripts/tunnel_helper.py" install            # 最新版
"$PY" "$CFT/scripts/tunnel_helper.py" install --version 2025.8.1
```

GitHub 不通时告诉用户手动下载 `cloudflared-linux-amd64`，放到 `$CFT/bin/cloudflared` 并 `chmod 755`，再 `check`。

## Quick 模式

```bash
"$PY" "$CFT/scripts/tunnel_helper.py" quick --port 9120
# 或 --url http://127.0.0.1:9120 ，自签 HTTPS 加 --no-tls-verify
```

- 先用 `curl -I http://127.0.0.1:<port>` 确认本地服务在跑，2xx/3xx/401/403 都算可达。helper 内部也会校验，未监听会直接报错。
- 后台启动，等到日志出现 `trycloudflare.com` 地址和 `Registered tunnel connection` 后返回 JSON：`public_url`、`pid`、`log_file`、`stop_command`。
- 同一本地地址已在运行时复用（`"reused": true`），换了端口会停掉旧隧道再起新的。
- `api.trycloudflare.com` 偶发失败会自动重试 3 次。

启动后验证并回报：

```bash
"$PY" "$CFT/scripts/tunnel_helper.py" verify --url https://xxxx.trycloudflare.com
```

新域名 DNS 传播可能要 1–2 分钟，`verify` 失败先等一下再试，不要立刻判定隧道已失效。

## Named 模式

前提由用户在 Cloudflare Zero Trust → Networks → Tunnels 完成：创建隧道、配置 Public Hostname → `http://127.0.0.1:<port>`、复制 token。token 写进 `$HERMES_HOME/.env`：

```
CLOUDFLARE_TUNNEL_TOKEN=eyJ...
```

然后：

```bash
"$PY" "$CFT/scripts/tunnel_helper.py" named --hostname app.example.com
```

token 也可用 `--token` 传入，但不要把它贴到回复、日志或其他文件里。ingress（域名 → 本地端口）在 Cloudflare 面板配置，helper 不写本地 config 文件，`references/named-tunnel.md` 里的 `tunnel login` 流程需要浏览器，NAS 上不适用。

## 状态、日志、停止

```bash
"$PY" "$CFT/scripts/tunnel_helper.py" status
"$PY" "$CFT/scripts/tunnel_helper.py" logs --mode quick --lines 40
"$PY" "$CFT/scripts/tunnel_helper.py" stop               # 全部
"$PY" "$CFT/scripts/tunnel_helper.py" stop --mode quick
```

隧道进程由 helper 以独立会话启动，Gateway 重启不会把它收掉，控制面板也看不到它。因此：

- Quick 隧道用完即停，每次会话结束前 `status` 看一眼，有运行中的临时隧道主动提醒用户。
- 不要用 `pkill cloudflared` 或按端口杀进程，统一走 `stop`。

## 成功后回报格式

```
公网地址：https://xxxx.trycloudflare.com
本地地址：http://127.0.0.1:9120
模式：Quick（临时，cloudflared 退出、NAS 断网即失效）
停止：<stop_command>
```

Quick 模式务必附上"临时、任何人拿到链接都能访问、用完即停"的提醒。

## 故障排查

| 现象 | 处理 |
|---|---|
| `local service returned HTTP 5xx` / 连接拒绝 | 目标服务没起来，WebApp 在控制面板"设置"里启动，确认 `ss -tlnp | grep <port>` |
| `did not find trycloudflare.com URL` / 超时 | NAS 到 Cloudflare 不通或 DNS 问题，看 `logs`，检查统一代理，重试 |
| 公网 404 | 发布的端口不对（如选了 8642），换 9120 |
| 公网 502 | 本地服务在隧道启动后退出了，重启服务再 `quick` |
| `install` 下载失败 | GitHub 被墙，手动放二进制到 `$CFT/bin/cloudflared` |
| 手机打不开 | 等 DNS 传播，`verify` 在系统 DNS 查不到时会改用 DoH（DNS over HTTPS）查询，可借此先确认服务端正常 |

更多见 `references/troubleshooting.md`。
