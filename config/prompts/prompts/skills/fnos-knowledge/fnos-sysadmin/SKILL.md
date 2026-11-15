---
name: fnos-sysadmin
description: fnOS 系统管理（系统全景/存储/用户/网络/安全/备份）、故障排查、Docker 排障与 OpenList 集成
---

# fnOS 系统管理知识

> **操作 fnOS 优先用官方 `fnos-cli`**（技能 `skills/fnos/SKILL.md`，模块：system / storage / monitor / file / app / docker / logger / network / user / power）。本文件只保留 fnos-cli 未覆盖的管理规范、WEB UI 路径、安全策略、备份方案与故障排查决策。
> 应用开发与 API 见 `fnos-dev-api`；Hermes 自身运维与删除决策见 `hermes-workflows`。

---

# 第一部分：系统全景

## 一、系统定位

fnOS（飞牛私有云）是广州铁刃智造开发的 NAS 专用操作系统：基于 Debian 深度定制，行为与标准 Debian 有差异；存算分离（系统盘与数据盘独立，重装不丢数据）；用户/存储/网络/防火墙由 WEB UI 统一管理，CLI 绕过可能破坏系统状态；迭代快，以当前实际版本为准（`fnos-cli system trim-version` 或 `cat /etc/fnos/version`）。

## 二、存储结构

```
/vol<N>/                          存储池根目录（卷号由用户决定，不要假设 vol1）
/vol<N>/@appcenter/<appname>/     应用程序文件（= /var/apps/<appname>/target）
/vol<N>/@appdata/<appname>/       应用运行数据（升级保留）
/vol<N>/@apphome/<appname>/       应用用户 HOME（= /var/apps/<appname>/home）
/vol<N>/@appshare/<name>/         应用声明的共享目录
/vol<N>/@team/<teamname>/         团队文件夹
/vol<N>/<uid>/<folder>/           用户存储文件夹（uid 从 1000 起）
/vol<N>/<uid>/.@#local/trash/     用户个人回收站（fnOS 私有格式，无 .trashinfo）
/usr/trim/  /etc/fnos/            fnOS 私有组件与配置（只读，禁改）
/etc/docker/daemon.json           由 fnOS 管理，CLI 直接修改会导致容器丢失
```

- 重装系统只格式化系统盘，重装后在「存储管理」重新挂载；同盘安装选「只格式化系统分区」；换机器直接移盘后挂载。
- 支持 JBOD / RAID 1 / RAID 5 / SHR。存储池、磁盘、SMART：`fnos-cli storage overview|pools|disks|smart <disk>|health <disk>`。挂载/扩容/换盘/格式化等高危操作要求 `--yes`，先核实用户意图。

## 三、用户与权限

| 层级 | 特征 |
|---|---|
| 超级管理员 | 第一个创建的用户；完整 sudo；默认 SSH；不可删除 |
| 管理员 | 部分 sudo；需手动开启 SSH |
| 普通用户 | 无 sudo/SSH；只能访问授权文件夹；可设配额 |
| 应用用户 | 用户名=appname；沙箱隔离；默认只能访问自身 `$TRIM_PKGVAR`/`$TRIM_PKGHOME` |

- 用户管理用 `fnos-cli user ...` 或 WEB UI，**禁止** `useradd/usermod/userdel`。
- 文件权限：v1.2.0+ 为 Windows ACL 模型（「删除」是独立权限，父级读写≠可删）。查看：`fnos-cli file acl get <path>`；修改通过 WEB UI，CLI 改动可能被覆盖。
- 应用访问用户文件夹需用户在 WEB UI 授权。应用调用 Docker 需 privilege 声明 `join-groups: ["docker"]`。

---

# 第二部分：网络配置

## 一、端口

系统保留：5666（WEB UI HTTP）、5667（WEB UI HTTPS / WS API）、22（SSH，可改）、445（SMB）、2049（NFS）、5005/5006（WebDAV）、8000（飞牛影视）。第三方应用建议 18000–19999。

SSH 开关：`fnos-cli network ssh switch --enable|--disable --yes`。

## 二、网络接口

- 多网卡 / 链路聚合：WEB UI → 设置 → 网络 → 网络接口（主备 Active-Backup 高可用；802.3ad LACP 需交换机支持）。
- 静态 IP：WEB UI → 网络 → 手动配置，或路由器按 MAC 绑定 DHCP。
- 推荐 DNS 主备：223.5.5.5 / 119.29.29.29 / 1.1.1.1 / 8.8.8.8。
- WOL：BIOS 开启 + 有线；MAC 见 WEB UI → 设置 → 电源 → 网络唤醒。

## 三、远程访问

| 方案 | 配置路径 | 适用 |
|---|---|---|
| fnConnect | WEB UI → 远程访问 → fnConnect | 免费、临时 |
| DDNS + 端口转发 | WEB UI → 域名与证书 → DDNS | 有公网 IP；WEB UI/SSH 外网端口必须改成非默认 |
| 反向代理 | WEB UI → 反向代理 | 统一 HTTPS 443，隐藏内部端口 |
| VPN（WireGuard） | 应用中心 | 不暴露任何端口，首选 |

## 四、常见网络问题

- NAS 无法上外网：按 网关 → DNS → 直连 IP → MTU 排查。
- Docker 容器无法上外网：在 Docker 管理 WEB UI 配置 DNS，**不要编辑 `/etc/docker/daemon.json`**。
- SMB 慢：确认同子网；家庭环境可关 SMB 签名（WEB UI → 文件共享 → SMB → 高级）；用 SMB3。

---

# 第三部分：安全

| 项目 | 做法 |
|---|---|
| SSL 证书 | 默认自签名；Let's Encrypt：WEB UI → 域名与证书（需公网域名）；或导入 .crt/.key。自动应用于 WEB UI / 反代 / WebDAV |
| SSH 加固 | 改端口（WEB UI → 安全 → SSH）、ed25519 密钥、禁密码、仅必要账户。日志：`journalctl -u ssh -n 50 --no-pager`、`grep "Failed password" /var/log/auth.log` |
| 防火墙 | WEB UI → 设置 → 安全 → 防火墙。禁止 `iptables -F`；紧急封 IP：`sudo iptables -A INPUT -s <IP> -j DROP`（重启失效） |
| 账户 | 密码策略（用户管理）、2FA（个人设置 → 两步验证）、登录锁定（安全 → 账户保护） |
| 暴露面 | WEB UI / SMB / NFS 仅内网；公网走 fnConnect / VPN / 反代 443 |
| 数据 | 存储池加密 AES-256（丢密钥=丢数据）；文件夹最小授权；回收站设置开启自动清理与「SMB 删除进回收站」 |

每月巡检：`cat /etc/fnos/version`、`lastb -n 20`、`ss -tlnp`、`find / -perm -4000 -type f 2>/dev/null | grep -v proc`、`crontab -l`。

已知安全事件：2026-02 路径穿越 RCE 与 OTA 升级被木马破坏，影响 ≤1.1.15，1.1.18+ 修复。版本过低立即升级，OTA 失败从 fnnas.com 下载完整镜像重装。

---

# 第四部分：同步与备份

- 3-2-1：3 份副本、2 种介质、1 份异地。
- rsync：

```sh
rsync -avz /vol1/1000/documents/ /vol2/backup/documents/                       # 卷间，不同步删除
rsync -avz -e "ssh -p 22" /vol1/1000/docs/ admin@远程IP:/vol1/backup/docs/      # 远程
rsync -avz --exclude='.@#local' --exclude='*.tmp' /vol1/1000/ /vol2/backup/     # 排除私有目录
0 2 * * * rsync -az /vol1/1000/documents/ /vol2/backup/documents/ >> /path/rsync.log 2>&1   # crontab
```

选项：`-a` 归档 `-z` 压缩 `-P` 进度续传 `--delete` 同步删除（谨慎） `--dry-run` `--bwlimit=KB/s`。

- 同步助手：WEB UI → 应用中心 → 同步助手（实时/定时、单向/双向、过滤）。开启「同步删除」后源端误删会同步。
- 快照：WEB UI → 存储 → 快照（Btrfs/ZFS）。
- 频率建议：工作文档每天（rsync/同步助手）；照片视频每周 + 云；`@appdata` 与 Docker 卷每天；整卷快照每月。
- 迁移：扩容走 WEB UI → 存储池 → 更换磁盘；停机迁移 = 新卷 rsync → 停服务验证 → 切换；换硬件 = 备份 @appdata → 移盘 → 装同版 fnOS → 存储管理导入 → 重装应用。

---

# 第五部分：故障排查

## 一、原则

先只读查询再操作。按 网络 → 系统 → 应用 → 数据 分层。不确定的操作先描述给用户等确认。

## 二、WEB UI 无法访问

```sh
ss -tlnp | grep -E "5666|5667"       # 端口监听
systemctl status nginx
tail -50 /var/log/nginx/error.log
journalctl -n 100 -p err --no-pager
df -h                                  # 磁盘是否满
```

常见原因：磁盘写满 / 端口被占 / fnOS 服务崩溃 / 防火墙拦截。

## 三、SSH 无法连接

SSH 未开启或用户未授权（WEB UI → 安全 → SSH）；重装后指纹冲突 `ssh-keygen -R <NAS_IP>`；端口已修改（WEB UI 查看）。

## 四、存储空间告警

```sh
fnos-cli storage overview                               # 或 df -h /vol<N>/
du -sh /vol<N>/*/ 2>/dev/null | sort -rh | head -10
du -sh /vol<N>/@appdata/*/ 2>/dev/null | sort -rh
find /vol<N>/ -size +500M -type f 2>/dev/null | head -20
sudo docker system df -v 2>/dev/null
```

释放顺序：清空回收站 → `docker image prune -f` → `docker container prune -f` → 清应用日志。`volume prune` 可能删应用数据，执行前确认。

## 五、应用无法启动

```sh
fnos-cli app status <appname>
tail -100 /vol<N>/@appdata/<appname>/logs/*.log 2>/dev/null
ss -tlnp | grep <端口>                     # 端口冲突
ls -la /vol<N>/@appdata/<appname>/         # 目录权限
df -h /vol<N>/                             # 空间不足也会启动失败
```

## 六、Docker

查询用 `fnos-cli docker stats|image ls|container ls [--all]|compose ls`；拉镜像 `fnos-cli docker image pull <img> --yes`。

权限：超级管理员默认可 `sudo docker`；其他账户需加入 docker 组；Hermes（应用用户）默认无权限，需 privilege `join-groups: ["docker"]` 并由用户在 WEB UI → 应用管理 → Hermes Agent → 权限 中授权。

| WEB UI 操作 | 路径 |
|---|---|
| 容器状态 / 日志 | Docker 管理 → 容器 → 选择容器 → 日志 |
| 新建 Compose 项目 | Docker 管理 → 项目 → 新建项目 → 粘贴 yml |
| 镜像 / 镜像加速器 | Docker 管理 → 镜像 / 注册表设置 |

```sh
sudo docker logs --tail 50 <container>
sudo docker inspect <container> | grep -A3 '"ExitCode"'   # 0 正常 1 应用错误 125 配置错误 137 OOM 139 段错误 143 SIGTERM
sudo docker exec -it <container> ping 8.8.8.8 && sudo docker exec -it <container> nslookup baidu.com
systemctl status docker && journalctl -u docker -n 50 --no-pager   # 服务级故障，常见于 daemon.json 被手改
sudo docker info | grep "Docker Root Dir"                 # 数据目录，不要指到回收站/@appcenter/系统目录
```

## 七、fnos-cli / API 连接失败

- fnos-cli 登录、profile、授权失效：按 `skills/fnos/entries/trim-shared.md` 与 `reference/oauth.md` 处理。OAuth 需 fnOS ≥ 1.2.0800，授权管理在 WEB UI → 我的账号 → 授权管理。
- 直连 WS API 的签名与 errno（4352 权限不足、4353 Token 失效、65534 验签失败）见 `fnos-dev-api` 第三部分。
- 基础连通：`ss -tlnp | grep 5667`、`curl -sk https://<NAS_IP>:5667/ | head`。

## 八、回收站

```
个人：/vol<N>/<uid>/.@#local/trash/
团队：/vol<N>/@team/<teamname>/.@#local/trash/
```

- 查看/恢复/清空：`fnos-cli file trash list|search|restore <path> --yes|clear --yes`；团队回收站 `fnos-cli file team trash-list-trashbin|trash-list|trash-restore|trash-clear`。
- **`fnos-cli file rm` 与 SSH `rm` 都是永久删除**。`file.rm` 的 `moveToTrashbin: true` 曾实测仍为永久删除。要进回收站：`fnos-cli file mv <src> /vol<N>/<uid>/.@#local/trash/ --yes`（受 ACL 限制可能失败），否则引导用户在 WEB UI 文件管理器删除。
- 同名文件进回收站自动改名 `report.pdf` → `report_1.pdf`。无 `.trashinfo`，原路径由系统维护。
- 决策树与话术见 `hermes-workflows` 第八节。

## 九、系统日志

```sh
journalctl -n 100 -p err --no-pager
journalctl --since "1h ago" --no-pager
journalctl -b --no-pager | grep -i error
tail -50 /var/log/nginx/error.log
```

日志中心：`fnos-cli logger list|modules|clear|export`。

## 十、重置与恢复

- OTA 失败：fnnas.com 下载完整镜像 USB 重装，数据盘不受影响，重装后重新挂载。
- 忘记管理员密码：本地控制台重置，或完整镜像重装（数据不丢）。
- 应用数据损坏：`fnos-cli app stop <appname> --yes` → 从备份恢复或删除损坏配置 → `fnos-cli app start <appname> --yes`。

---

# 第六部分：OpenList 集成

OpenList 是开源网盘聚合工具（本地、阿里云盘、夸克、115 等）。本应用不内置 OpenList 脚本。社区 MCP Server <https://github.com/hbestm/openlist-mcp-server> 提供约 79 个工具（浏览搜索、文件管理、上传下载、分享、离线下载、存储挂载、索引、解压、重复文件等），**需用户自行安装配置**。

```bash
git clone https://github.com/hbestm/openlist-mcp-server.git && cd openlist-mcp-server
python3 -m venv venv && source venv/bin/activate && pip install -e .
```

```yaml
mcp_servers:
  openlist:
    command: /path/to/openlist-mcp-server/venv/bin/python
    args: ["-m", "openlist_mcp"]
    env:
      OPENLIST_URL: "http://<OpenList地址>:5244"
      OPENLIST_USERNAME: "<用户名>"
      OPENLIST_PASSWORD: "<密码>"
```

写入 `config.yaml` 后重启 Gateway 生效（见 `hermes-workflows` 第四节）。未安装 MCP 时引导用户在 OpenList Web UI 操作：首页浏览 / 目录内上传 / 选中文件 → 分享 / 管理 → 存储 / 管理 → 索引 → 重建。
