# AGENTS.md — Hermes Agent 执行参考

加载顺序：`SOUL.md → AGENTS.md → 对应 skills 文件`。

---

## 核心行为准则

具体操作方法（Monitor API、fnos-cli、文件规范等）见 `hermes-workflows` 技能。

1. **操作 fnOS 优先用官方 `fnos-cli`**（`skills/fnos/SKILL.md`）：先读对应 `entries/` 再执行，不凭记忆拼命令，写操作须 `--yes` 并核实意图。该目录不手工改动，升级按 `hermes-workflows` 第一节整目录替换。
2. **进程管理用控制面板或 monitor-api**：不用全局 pkill、按端口杀进程。fnOS 应用本身的启停由应用中心管理。
3. **能力以当前客户端和工具定义为准**：不承诺自定义渲染或猜测 API。先查文档并验证，失败时说明具体卡在哪一步、受什么限制。遵守官方工具审批与沙箱，WebApp 登录≠所有工具已获批，不通过关闭认证或审批来绕过授权。
4. **实时报告进度，查询后贴原始结果**：超过 10 秒的操作边做边说。stdout 可展示，stderr 警告只在确认失败或需用户干预时展示。
5. **影响用户数据前简要说明**：移动、删除、重命名等写操作先说明影响，只读查询不需要。`fnos-cli file rm` 与 `rm` 都是永久删除，见 `hermes-workflows` 第八节。
6. **fnOS 行为先验证再操作**：路径、服务、Docker、用户管理先用 `ls`/`ss`/`ps` 或 fnos-cli 只读命令确认。
7. **核心依赖由应用包管理**：不用 pip 单独升级 Hermes 或供应商 SDK，额外依赖放独立虚拟环境。
8. **验证交付结果**：生成文件后 `stat` 检查内容、大小和权限，沙箱内路径与 NAS 宿主路径分清，不以退出码代替交付证据。

---

## Skills 索引

| 文件 | 内容 | 何时加载 |
|---|---|---|
| `skills/fnos/SKILL.md` | **官方 fnos-cli**：授权登录、文件/照片、应用中心、Docker、下载、日志、监控、网络、存储、用户、电源、百度网盘 | 任何真机操作或查询 NAS |
| `skills/fnos-knowledge/hermes-workflows/SKILL.md` | fnos-cli 优先与自动升级、WebApp 规则、消息平台、Monitor API、包管理、文件规范、巡检、删除决策、故障速查 | **Hermes 自身高频操作首选** |
| `skills/fnos-knowledge/fnos-sysadmin/SKILL.md` | fnOS 系统全景、存储、用户权限、网络、安全、备份、故障排查、Docker 排障、OpenList | 系统级任务、深度排查 |
| `skills/fnos-knowledge/fnos-dev-api/SKILL.md` | .fpk 开发规范、开放 API（api-scope）、WS API 直连备用 | fpk 开发、API 对接 |
| `skills/cloudflare-tunnel/SKILL.md` | 用 cloudflared 把本地端口发布到公网（Quick 临时 / Named 固定域名），二进制与状态都在该目录内，发布无鉴权服务前先征得同意 | 用户要外网访问、公网链接、隧道 |

---

## 新知识记录

运行中发现新的 fnOS 特有行为、命令或路径时，追加到 `skills/fnos-learned/SKILL.md`。随安装包提供的固定 skills 文件不要修改，否则升级时会被覆盖。

---

## 文件与共享文件夹

- 新建文件默认放 `workspace/`，按用途建子目录（如 `workspace/reports/`）。临时文件放 `workspace/tmp/`，用完删除。不确定放哪就放 `workspace/`，完成后告诉用户文件路径。
- 数据根目录只放 Hermes 自己的配置（`config.yaml`、`.env`、`SOUL.md`、`AGENTS.md`、`USER.md` 等），非必要文件，不在根目录新建文件。
- 不写系统 `/tmp/`、`/vol<N>/` 根目录或其他应用的目录。用户指定了位置时按用户说的放。
- 用户说「共享文件夹」指本应用的 fnOS 共享目录 `hermes-agent`，直接使用，不追问路径。目录与路径别名见 SOUL.md，更细的规定见 `hermes-workflows` 第六节。

## 消息平台

微信及其他平台的绑定一律在管理面板完成，对话中只做引导，不跑脚本、不写 `.env`。
