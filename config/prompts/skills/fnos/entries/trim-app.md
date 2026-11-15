---
name: trim-app
description: 管理已安装应用、应用中心安装、FPK 软件包、更新、应用入口与生命周期操作。
---

# 应用中心

管理 fnOS 应用：列出、查看、安装、安装 FPK、更新、启动、停止和卸载。
端点及字段见 `../reference/app-center.md`；连接或会话故障见 `trim-shared.md`。

## 规则

- 安装、更新和生命周期变更等写操作必须显式传入 `--yes`。
- 只有无需界面决策的流程才能自动执行。许可确认需要 `--accept-license`；依赖变更和运行中的依赖应用必须在应用中心界面处理。自定义向导输入须显式提供 `--custom-parameters`。
- `app install` / `app update` 创建并轮询下载任务，再启动并等待安装或更新任务。`--dry-run` 只下载/解析软件包、读取信息并执行安全检查，不启动安装。
- 本地 FPK 先使用 `app install-fpk <file> --volume-id <id> --dry-run --yes` 预检；这会上传并解析 FPK、检查约束，但不安装。
- NAS 上的 FPK 使用 `--remote-path /vol.../demo.fpk`，必须是具体 NAS FPK 路径，最大 10GB。
- 上传错误 `20001` 表示存储不可用；检查 `--volume-id` 对应卷是否存在、已挂载且健康。
- 新应用已知来源时提供 `--source-id`；更新从已安装列表解析 `sourceID`。
- 优先显式指定 `--volume-id`；否则 CLI 使用应用中心默认下载/安装卷，没有可用默认卷时拒绝执行。
- `--custom-parameters '<jsonArray>'` 映射到 `customParameters`；`--api-scope '<jsonObject>'` 映射到 `systemParameters.apiScope`。缺少必需自定义向导输入时停止并提示用户使用应用中心界面。
- `--cancel-on-failure` 在任务失败时尝试对应取消端点，并在错误中包含取消结果。
- `app openapi ...` 管理应用用户授权路径；新增需要 `--yes` 和具体 `/vol...` 路径。
- `app entry list`、`app desktop list` 和 `app sac app-store-list` 使用 `appcgi.sac.entry.v1.*` WebSocket CGI，不使用旧入口 REST。
- 没有固定命令的桌面入口写操作使用 `raw`，并显式传入 `--yes`。
- `app config set-sys` 在发送前拒绝无效默认卷、更新时间窗口、云策略和布尔设置。只有确认后端兼容并传入 `--allow-desktop-icon-field` 后才发送 `autoCreateDesktopIcon`。
- 应用默认在安装后启动；使用 `--no-start` 保持停止状态。

## 命令

```bash
fnos-cli --host <host> --port <port> app list
fnos-cli --host <host> --port <port> app status <appName>
fnos-cli app entry list
fnos-cli app desktop list
fnos-cli app sac app-store-list
fnos-cli app install <appName> --version <version> --source-id <sourceID> --volume-id <volumeId> --dry-run --yes
fnos-cli app install <appName> --version <version> --volume-id <volumeId> --custom-parameters '[{"key":"port","value":8080}]' --api-scope '{"API.User.FileAccess":true}' --yes
fnos-cli app install <appName> --version <version> --volume-id <volumeId> --accept-license --cancel-on-failure --yes
fnos-cli app install-fpk <localFile.fpk> --volume-id <volumeId> --dry-run --yes
fnos-cli app install-fpk --remote-path /vol1/1000/demo.fpk --volume-id <volumeId> --dry-run --yes
fnos-cli app update <appName> --version <version> --volume-id <volumeId> --dry-run --yes
fnos-cli app openapi add-user-auth-path <appName> /vol1/1000/docs --yes
fnos-cli app start <appName> --yes
fnos-cli app stop <appName> --yes
fnos-cli app uninstall <appName> --yes
```
