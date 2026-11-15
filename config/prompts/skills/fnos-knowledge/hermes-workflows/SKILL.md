---
name: hermes-workflows
description: Hermes Agent 在 fnOS 上的运维工作流：官方 fnos-cli Skill 优先与自动升级、WebApp 规则、消息平台接入、Monitor API 进程管理、包管理、文件管理规范、健康巡检、运行时记忆、文件删除决策树、故障速查。
---

# Hermes 工作流与运维规范

> **分工**：操作 fnOS（文件、存储、应用、Docker、监控、日志、用户、网络、电源）用官方 `fnos-cli`（第一节）；fnOS 管理规范与故障排查见 `fnos-sysadmin`；应用开发与 API 见 `fnos-dev-api`。本文只写 Hermes 自身的工作流与约定。

---

## 一、官方 fnos-cli Skill：优先使用与自动升级

### 1.1 位置与使用

- 官方 Skill 随应用内置，运行时路径 `$HERMES_HOME/skills/fnos/`（源于应用包 `config/prompts/skills/fnos`），名称 `fnos-cli`，版本见 `manifest.json` 的 `version`（当前随包 0.6.1）。
- 任何 fnOS 操作先读 `skills/fnos/SKILL.md` 与对应 `entries/trim-*.md`，再用启动器 `$HERMES_HOME/skills/fnos/scripts/fnos-cli` 执行。不要凭记忆拼命令，先 `--version` 与 `--help`。
- 首次运行会联网下载一份固定版本 CLI 到 `~/.cache/fnos-cli/<版本>/<平台>/`（按包内 SHA-256 校验）。下载失败按 `skills/fnos/runtime-setup.md` 处理。
- 授权：`fnos-cli --profile <p> --host <NAS 内网 IP> --port 5666 login --authorize-only` → 把链接交给用户 → 用户回传一次性 code → `login --code '<code>'` → 只读验证 `system info`。需 fnOS ≥ 1.2.0800。不复述、不落盘 code；token 不输出到聊天。
- 写操作须 `--yes` 且先核实用户意图。`file rm` 是永久删除（见第八节）。
- 该目录是官方产物，**不手工修改其中任何文件**。启动器会校验 `runtime-manifest.json` 的哈希，单独改文件会导致启动失败。升级只能整目录替换。

### 1.2 自动检测与升级

触发时机：用户提到 fnos-cli / 飞牛 skill 升级；用户要求巡检时顺带检查（每天最多一次）；fnos-cli 报“需要更高版本”时。不在正在执行 fnOS 任务的中途升级。

```bash
SKILL_DIR="$HERMES_HOME/skills/fnos"
LOCAL=$(grep -oE '"version": *"[0-9.]+"' "$SKILL_DIR/manifest.json" | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
PAGE=$(curl -fsSL --max-time 20 https://fnnas.com/download)
# 页面把 JSON 转义嵌在 RSC 数据里，形如 \"skill\":{\"url\":\"...fnos-skill-v0.5.1.zip\",\"hash\":\"<sha256>\",\"version\":\"0.5.1\"}
REMOTE=$(printf '%s' "$PAGE" | LC_ALL=C grep -oE 'fnos-skill-v[0-9]+\.[0-9]+\.[0-9]+\.zip' | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
URL=$(printf '%s' "$PAGE" | LC_ALL=C grep -oE 'https://[^"\\]*fnos-skill-v[0-9.]+\.zip' | head -1)
HASH=$(printf '%s' "$PAGE" | LC_ALL=C grep -oE 'fnos-skill-v[0-9.]+\.zip.{0,40}[0-9a-f]{64}' | head -1 | grep -oE '[0-9a-f]{64}' | head -1)
echo "local=$LOCAL remote=$REMOTE url=$URL hash=$HASH"
```

判定：`[ "$(printf '%s\n%s' "$LOCAL" "$REMOTE" | sort -V | tail -1)" = "$REMOTE" ] && [ "$LOCAL" != "$REMOTE" ]` 为真才升级；相等或本地更新则只汇报“已是最新/本地更新”。页面抓不到版本时报告失败，不猜。

升级步骤（全部在 `$HERMES_HOME/skills/` 内完成，先告知用户再执行）：

```bash
TMP="$HERMES_HOME/workspace/tmp/fnos-skill-$REMOTE"; mkdir -p "$TMP"
curl -fsSL --max-time 120 -o "$TMP/skill.zip" "$URL"
[ -n "$HASH" ] && [ "$(sha256sum "$TMP/skill.zip" | cut -d' ' -f1)" = "$HASH" ] || { echo "sha256 不匹配或缺失，中止"; exit 1; }
unzip -q "$TMP/skill.zip" -d "$TMP/unzipped"
NEWV=$(grep -oE '"version": *"[0-9.]+"' "$TMP/unzipped/fnos/manifest.json" | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
[ "$NEWV" = "$REMOTE" ] || { echo "包内版本 $NEWV 与页面 $REMOTE 不一致，中止"; exit 1; }
mv "$SKILL_DIR" "$HERMES_HOME/skills/fnos.bak-$LOCAL"
mv "$TMP/unzipped/fnos" "$SKILL_DIR" && chmod +x "$SKILL_DIR/scripts/fnos-cli"
"$SKILL_DIR/scripts/fnos-cli" --version && rm -rf "$TMP"
```

- zip 顶层必须是 `fnos/` 目录（与内置结构一致）；不是则中止。
- `--version` 失败就把 `fnos.bak-<旧版本>` 挪回去，报告失败原因。成功后保留备份目录一轮，下次升级再清理。
- 新版本 CLI 二进制会在首次运行时重新下载，旧缓存目录可手动清理。
- 官方下载地址 `https://iso.liveupdate.fnnas.com/ai_labs/trim_cli/fnos-skill-v<版本>.zip` 可能返回 403（2026-11-10 在国外出口实测）。此时报告给用户，**经用户同意后**才可改用 GitHub Release 备用源 `https://github.com/fnnas-labs/fnos-cli-skill/releases/download/v<版本>/fnos-skill.zip`（无官方 sha256，需用解压后 `manifest.json` 版本与 `runtime-manifest.json` 存在性校验，并在报告中注明来源非 fnnas.com）。
- fnnas.com/download 页面版本可能滞后于 GitHub（2026-11-10 页面 0.5.1，GitHub 已 0.6.1）。以页面为自动升级依据，GitHub 更新的版本只在用户要求时处理。

---

## 二、官方 WebApp 使用规则

- 通过 fnOS 控制面板打开 WebApp，用配置好的账号登录。NAS 管理员登录不代替 WebApp 账户认证。
- 使用官方客户端提供的聊天、Markdown、文件、工具审批与终端能力。以实际客户端和当前工具定义为准。
- 生成文件后核验内容，通过官方文件接口或用户指定的共享目录交付。不要把 NAS 本地路径拼成浏览器链接。
- 保留 `/app/hermes-agent/webapp/` 完整子路径。不展示或保存认证 Cookie、密码和票据。
- 工具失败时检查模型协议、日志、锁定依赖和审批状态，不用全开工具或关闭审批替代修复。

---

## 三、消息平台接入

微信、QQ、钉钉、飞书、元宝等平台的绑定都在 Hermes 管理面板完成（微信扫码、其他平台填写凭证），面板自动写入配置并重启 Gateway。用户询问接入时直接引导打开管理面板，不要在对话里跑脚本、手写 `.env`/`config.yaml` 或生成二维码。只读查询已绑定微信账号：`ls "$TRIM_PKGHOME/data/weixin/accounts/"*.json 2>/dev/null`。

---

## 四、进程管理（Monitor API）

不要全局 `pkill` 或按端口杀进程。在已设置 `APP_DIR`、`DATA_DIR` 的运行环境内：

```bash
"$APP_DIR/bin/monitor-api" status | webapp/status | dashboard/status
"$APP_DIR/bin/monitor-api" restart | stop | webapp/stop | dashboard/stop
```

- 首次配置认证、公开地址、开启 WebApp/Dashboard 用控制面板。
- `webapp/stop` 只关 WebApp 但可能重启共享 Gateway；`stop` 停整个 Gateway，不关独立 Dashboard；`dashboard/stop` 只停 Dashboard（9119，默认不自启，经 `/app/hermes-agent/dashboard/` 访问）。
- 命令只通过 Unix socket（`$TRIM_APPDEST/hermes-agent.sock`）调用，读取当前 HOME 的令牌。错误须如实报告，配置已保存≠重启成功。
- 只读诊断：`ss -tlnp | grep <port>`、`ps aux | grep hermes`、`lsof | grep .sock`。

---

## 五、核心与依赖管理

- 用户要求主动降级、切回旧内核或降级后 WebApp/Dashboard 打不开时，必须先读相邻 `hermes-safe-downgrade/SKILL.md`。完成前不要刷新或关闭当前对话窗口，并先验证独立执行与恢复通道，不能在活动源码目录原地切版本或批删 `.hermes-stale`。
- 核心、WebApp、Dashboard 的基础资源随 FPK 提供。已自主升级的内核必须使用与当前源码、依赖和构建收据匹配的资源，不用包内旧资源覆盖新版。资源故障先核对当前代，按实际支持的修复/构建流程处理，不清用户数据。
- 依赖由应用包用 Python 3.14 与官方 `uv.lock` 安装。对话中不用 `pip` / `uv pip install --upgrade` 替换 Hermes、供应商 SDK 或锁定依赖。用户任务需要额外库时用独立工作目录虚拟环境。
- 排查版本读实际解释器与安装日志，不假定系统全局 Python。

---

## 六、文件管理规范

### 6.1 目录

`$TRIM_PKGHOME/data`（= `$HERMES_HOME`）：`config.yaml` `.env` `SOUL.md` `AGENTS.md` `USER.md`、`skills/`（含官方 `fnos/`）、`sessions/`、`workspace/`（产出）、`workspace/tmp/`（临时）、`venv/`、`memories/`、`logs/`。
`$TRIM_PKGVAR`：`monitor.token`、`*.pid`、`*.log`。路径别名对照见 SOUL.md。

### 6.2 共享文件夹

用户说「共享文件夹」指本应用的 fnOS 共享目录 `hermes-agent`：物理路径 `/vol<N>/@appshare/hermes-agent`，稳定入口 `/var/apps/hermes-agent/share/hermes-agent`，确认用 `readlink -f /var/apps/hermes-agent/share/hermes-agent`。默认直接用，不追问完整路径。Windows ACL，写入后 `stat` 验证。

### 6.3 写入位置（强制）

```
系统配置        → data/ 根（仅 .env、USER.md 等）
用户产出        → workspace/<用途子目录>/
用户点名共享文件夹 → /var/apps/hermes-agent/share/hermes-agent/
临时/缓存       → workspace/tmp/（用完清理；禁用系统 /tmp/）
日志            → logs/
不确定          → workspace/
```

禁止：写系统 `/tmp/`；在 `data/` 根建用户文件；写 `/vol<N>/` 根或其他应用目录。创建临时文件后汇报 `du -sh $TRIM_PKGHOME/data/workspace/tmp/`，超 500MB 提醒清理。

---

## 七、健康巡检

触发：每 30 分钟；启动后一次；用户说「巡检」「健康检查」「系统状态」。日志：`$TRIM_PKGHOME/data/logs/heartbeat.log`。

| 项目 | 方式 | 阈值 |
|---|---|---|
| 存储空间 | `fnos-cli storage overview` 或 `df -h /vol<N>/` | >80% 提醒，>90% 告警 |
| CPU / 内存 | `fnos-cli monitor cpu` / `monitor memory` 或 `free -h` | 内存 >90% |
| 负载 | `uptime` | 1 分钟负载 > 核心数×2 |
| 应用状态 | `fnos-cli app list` | 有应用 stopped |
| 回收站 | `fnos-cli file trash list` | 超 10GB |
| tmp 占用 | `du -sh $TRIM_PKGHOME/data/workspace/tmp/` | 超 500MB |
| 官方 Skill 版本 | 第 1.2 节检测（每天最多一次） | 有新版本则提示并按流程升级 |

```
【Hermes 巡检 YYYY-MM-DD HH:MM】
💾 /vol1/ 73%（剩余 2.1TB）✅
💻 CPU 12% 内存 58% ✅
📦 应用：全部运行中 ✅
🛠 fnos-cli skill 0.6.1（最新）✅
状态：正常
```

告警话术：`⚠️ /vol1/ 使用率 XX%，剩余 XXG。建议清理：回收站 / Docker 镜像 / 应用日志。需要我帮您查找大文件吗？`

---

## 八、文件删除决策树

fnOS v1.2.0+ 为 Windows ACL，「删除」是独立权限。应用沙箱权限与 `.@#local/trash/` 权限相互独立。

```
用户要求删除文件
├─ fnos-cli 已授权？
│   ├─ 是 → fnos-cli file mv <file> /vol<N>/<uid>/.@#local/trash/ --yes → 进回收站 ✅
│   │        （失败 → 转下面「永久删除」分支）
│   └─ 否 → Hermes 对该目录有写权限？
│       ├─ 是 → 用户接受「仅永久删除」？
│       │   ├─ 是 → 明确告知不可恢复，用户再次确认后 rm / fnos-cli file rm --yes
│       │   └─ 否 → 引导 WEB UI 删除
│       └─ 否 → 引导 WEB UI 删除
```

`fnos-cli file rm`、SSH `rm`、`file.rm`（含 `moveToTrashbin: true`）都是永久删除。无授权时话术：

```
我需要删除：[路径]
方案 1（安全）：在 fnOS 文件管理器中删除 → 进回收站，可恢复
方案 2：授权 fnos-cli 后由我移入回收站
方案 3（不可恢复，需您明确确认）：直接永久删除
请告诉我用哪种方式？
```

---

## 九、运行时记忆模板

首次运行或用户说「系统快照」时填充，用 `fnos-cli system info|hardware|vols`、`fnos-cli storage overview`、`fnos-cli app list`、`fnos-cli monitor memory`；SSH 备用 `cat /etc/fnos/version`、`uname -r`、`free -h`、`ip addr`。

```yaml
收集时间:
NAS_IP:
fnOS 版本:
内核版本:
CPU 型号 / 核心数:
内存总量:
存储池: { vol1: { 总容量: , 使用率: , 文件系统: } }
已安装应用:
网络: { 主网卡 IP: , 网关: , DNS: , SSH 端口: }
用户: { 超级管理员: , 其他账户: }
fnos-cli skill 版本:
用户偏好: { 语言: 中文, 回复风格: 简洁 }
```

---

## 十、故障速查与验证习惯

- **WebApp 打不开**：控制面板确认资源、认证、服务状态；检查 NAS 地址与 `/app/hermes-agent/webapp/` 前缀；看 Monitor 与 Gateway 日志。资源缺失覆盖安装完整包，不清数据、不关认证。
- **sandbox 写文件失败**：`id`（应为 hermes-agent）、`ls -ld $TRIM_PKGHOME/data/workspace/`；修复 `chmod 775` + `chown` 应用用户。
- **exit 0 但文件不存在**：sandbox overlay 会骗 `ls`，必须 `stat` 验证真实落盘。
- **服务验证**：WebApp 监听 `127.0.0.1:9120`，浏览器走 fnOS 网关。`ss -tlnp | grep 5667`（WEB UI）、`curl -sk http://localhost:8642/v1`（Gateway API）。端口占用不等于进程归属。
- **改 config.yaml**：`"$TRIM_PKGHOME/data/venv/bin/python" -c "import yaml; yaml.safe_load(open('config.yaml'))"` → Monitor API `restart` → `sleep 3 && ss -tlnp | grep 8642`。
- 运行时路径一律用 `$TRIM_PKGHOME` / `$TRIM_PKGVAR` / `$TRIM_APPDEST`，不硬编码卷号。
