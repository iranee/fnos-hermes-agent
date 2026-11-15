# 应用中心参考

## 命令概览

| 命令 | 用途 | 输出 |
| --- | --- | --- |
| `app list` | 列出应用中心已安装应用 | JSON |
| `app status <appName>` | 显示一个已安装应用记录 | JSON |
| `app base-data` | 读取应用中心侧栏、来源和标签基础数据 | JSON |
| `app store list` | 列出云端应用中心软件包 | JSON |
| `app store search <keyword>` | 搜索云端应用中心软件包 | JSON |
| `app store detail <appName>` | 显示云端软件包详情 | JSON |
| `app store latest-release` | 列出最新发布的软件包 | JSON |
| `app check-update` | 检查应用中心可用更新 | JSON |
| `app check-update --post` | 触发应用中心更新检查 | 成功消息 |
| `app common volume` | 读取应用中心记住的卷 | JSON |
| `app common volume --set <volumeId>` | 设置应用中心记住的卷 | 成功消息 |
| `app config sys/list/detail/auth-paths/wizard` | 读取应用中心系统和应用配置 | JSON |
| `app config set-sys --fields <json>` | 更新应用中心系统配置字段 | 成功消息 |
| `app config set <appName> --fields <json>` | 更新指定应用配置载荷 | 成功消息 |
| `app config auto-update <appName>` | 启用或禁用应用自动更新 | 成功消息 |
| `app config proxy-access <appName>` | 允许或拒绝代理访问 | 成功消息 |
| `app config post-wizard <appName> --fields <json>` | 提交应用向导自定义参数 | 成功消息 |
| `app service list` | 列出服务元数据 | JSON |
| `app entry list` | 列出可用应用入口 | JSON |
| `app desktop list` | 列出当前用户的桌面布局和入口 | JSON |
| `app guide check-installed <appName...>` | 检查引导所需应用是否已安装 | JSON |
| `app guide batch-download-install <volumeId> <appName...>` | 启动引导批量下载/安装任务 | 成功消息 |
| `app operation settings` | 读取操作设置 | JSON |
| `app openapi app-detail <appName>` | 读取授权流程所用的 OpenAPI 应用详情 | JSON |
| `app openapi allow-user-auth-paths <appName>` | 读取是否允许用户向应用授权路径 | JSON |
| `app openapi add-user-auth-path <appName> <path>` | 为应用新增当前用户授权路径 | 成功消息 |
| `app openapi add-user-auth-inherit-file <appName> <path>` | 为应用新增继承文件授权 | 成功消息 |
| `app sac app-store-list` | 读取 SAC 应用商店入口列表 | JSON |
| `app task-status <taskId>` | 查询应用中心通用任务 | JSON |
| `app task-cancel <taskId>` | 取消应用中心通用任务 | 成功消息 |
| `app download cancel <downloadTaskId>` | 取消应用中心下载任务 | 成功消息 |
| `app install-cancel <taskId>` | 取消应用中心安装任务 | 成功消息 |
| `app update-cancel <taskId>` | 取消应用中心更新任务 | 成功消息 |
| `app install <appName>` | 按名称和版本下载并安装应用中心软件包 | 成功消息 |
| `app install <appName> --dry-run` | 下载并检查应用中心软件包，不启动安装 | 成功消息 |
| `app install-fpk <localFile.fpk>` | 上传并安装本地 FPK 软件包 | 成功消息 |
| `app install-fpk --remote-path /vol.../*.fpk` | 安装已保存在 NAS 上的 FPK 软件包 | 成功消息 |
| `app install-fpk <localFile.fpk> --dry-run` / `--remote-path ... --dry-run` | 检查 FPK 软件包，不启动安装 | JSON 计划 |
| `app update <appName>` | 下载并将已安装应用更新到目标版本 | 成功消息 |
| `app update <appName> --dry-run` | 下载并检查应用中心更新，不启动更新 | 成功消息 |
| `app start <appName>` | 启动已安装应用 | 成功消息 |
| `app stop <appName>` | 停止已安装应用 | 成功消息 |
| `app restart <appName>` | 重启已安装应用 | 成功消息 |
| `app uninstall <appName>` | 卸载已安装应用 | 成功消息 |

## 端点

| 命令 | 方法 | 端点 |
| --- | --- | --- |
| `app list` / `app status` | GET | `/app-center/v1/app/installed` |
| `app base-data` | GET | `/app-center/v2/config/base-data` |
| `app store list` | GET | `/app-center/v1/app/list` |
| `app store search` | GET | `/app-center/v1/app/search` |
| `app store detail` | GET | `/app-center/v1/app/detail` |
| `app store latest-release` | GET | `/app-center/v1/app/latest-release` |
| `app check-update` | GET/POST | `/app-center/v1/check-update` |
| `app common volume` | GET/POST | `/app-center/v1/common/remember-volume` |
| `app config sys` | GET | `/app-center/v1/sysconfig` |
| `app config set-sys` | POST | `/app-center/v1/sysconfig` |
| `app config list/detail/auth-paths/wizard` | GET | `/app-center/v1/config/*` |
| `app config set` | POST | `/app-center/v1/config` |
| `app config auto-update` | POST | `/app-center/v1/config/app/auto-update` |
| `app config proxy-access` | POST | `/app-center/v1/config/proxy-access-allowed` |
| `app config post-wizard` | POST | `/app-center/v1/config/wizard` |
| `app service list` | GET | `/app-center/v1/service/list` |
| `app entry list` | WebSocket CGI | `appcgi.sac.entry.v1.getEntryList` |
| `app desktop list` | WebSocket CGI | `appcgi.sac.entry.v1.getUserDesktop` |
| `app guide check-installed` | POST | `/app-center/v1/app/check-installed` |
| `app guide batch-download-install` | POST | `/app-center/v1/batch-download-install` |
| `app operation settings` | GET | `/app-center/v1/operation/settings` |
| `app openapi app-detail` | GET | `/app-center/openapi/v1/app/detail` |
| `app openapi allow-user-auth-paths` | GET | `/app-center/openapi/v1/app/allow-user-authorization-paths` |
| `app openapi add-user-auth-path` | POST | `/app-center/openapi/v1/user/authorization-paths` |
| `app openapi add-user-auth-inherit-file` | POST | `/app-center/openapi/v1/user/authorization-paths/inherit-file` |
| `app sac app-store-list` | WebSocket CGI | `appcgi.sac.entry.v1.appStoreList` |
| `app task-status` | POST | `/app-center/v1/common/task-status` |
| `app task-cancel` | POST | `/app-center/v1/common/task-cancel` |
| `app download cancel` | POST | `/app-center/v1/download/cancel` |
| `app install` 信息 | GET | `/app-center/v1/install/info` |
| `app install` 启动 | POST | `/app-center/v1/install/task` |
| `app install-cancel` | POST | `/app-center/v1/install/cancel` |
| `app install-fpk` 上传 | POST | `/app-center/v1/download/upload` |
| `app install-fpk --remote-path` 软件包任务 | POST | `/app-center/v1/download/task`，使用 `packageSourceType=file` 和 `path` |
| `app install-fpk` 上传状态 | GET | `/app-center/v1/download/status` |
| `app update` 信息 | GET | `/app-center/v1/update/info` |
| `app update` 启动 | POST | `/app-center/v1/update/task` |
| `app update-cancel` | POST | `/app-center/v1/update/cancel` |
| `app start` 检查/启动 | POST | `/app-center/v1/start/check`, `/app-center/v1/start/start` |
| `app stop` 检查/启动 | POST | `/app-center/v1/stop/check`, `/app-center/v1/stop/start` |
| `app restart` | POST | `/app-center/v1/restart` |
| `app uninstall` 信息/启动 | GET/POST | `/app-center/v1/uninstall/info`, `/app-center/v1/uninstall/start` |

## 安全行为

所有写命令都要求 `--yes`。

当商店结果包含来源标识或需要指定版本时，`app store detail` 接受可选 `--source-id` 和 `--version`。

`app task-cancel` 要求 `--yes`。通用任务状态/取消端点在请求体中使用 `taskID`。

`app check-update --post`、`app common volume --set`、`app download cancel`、`app install-cancel`、`app update-cancel`、`app restart`、配置写入和引导批量下载/安装均为写操作，要求 `--yes`。

OpenAPI 用户授权写命令要求 `--yes` 和具体 `/vol...` 路径。这些命令对应应用/用户授权流程，不是应用中心全局设置。

配置写命令的 `--fields` 必须是 JSON 对象。`app config set` 在发送前向对象中加入 `appName`；`app config post-wizard` 也加入 `appName`，其 `--fields` 中应包含 `customParameters`。

`app config set-sys` 在发送前校验常用应用中心设置：

- `downloadAndInstallVolumeID` 必须为 `-1` 或正整数。
- 提供 `globalAutoUpdate.enabled` 时必须为布尔值。
- 启用全局自动更新或提供任一更新时间时，`updateStartTime` 和 `updateEndTime` 必须同时提供，格式为 `HH:MM`，有效时间窗口至少 60 分钟。
- 提供 `cloudSecuritySync.enabled` 时必须为布尔值。
- 启用云端安全同步或提供 `strategy` 时，`strategy` 必须为 `strict`、`balanced` 或 `lenient`。
- 提供 `autoRunNewApp` 时必须为布尔值。
- 当前应用中心界面载荷不发送 `autoCreateDesktopIcon`。CLI 默认拒绝该字段，只有传入 `--allow-desktop-icon-field` 才会发送；允许发送时该值必须为布尔值。

`app install` 和 `app update` 默认使用 `--package-type cloud`。两者先创建并轮询应用中心云端下载任务，再调用安装/更新信息及任务端点，等待返回的安装/更新任务完成。使用 `--dry-run` 仍会下载/解析云软件包并执行安全检查，但不调用安装/更新任务端点。`app install-fpk` 从已上传或远程软件包的状态推导 `packageType`，通常为 `file`。

`app install`、`app update` 和 `app install-fpk` 接受显式向导输入：

- `--custom-parameters '<jsonArray>'` 发送应用中心 `customParameters`。
- `--api-scope '<jsonObject>'` 发送 `systemParameters.apiScope`。
- `--accept-license` 在应用中心界面之外显式接受软件包许可确认。
- 安装/更新任务进入失败状态时，`--cancel-on-failure` 尝试对应安装/更新取消端点；原始失败上下文仍保留在 stderr 中。
- 应用中心要求自定义向导参数而未提供 `--custom-parameters` 时，CLI 在启动安装/更新任务前拒绝执行。

对 `app install`、`app update` 和 `app install-fpk`，建议提供 `--volume-id`。省略时 CLI 读取应用中心系统配置，使用 `downloadAndInstallVolumeID`，并以 `volumeID` 作为兼容后备。该值必须为正数；没有可用默认卷时拒绝执行并要求提供 `--volume-id`。

风险较高的手动安装前，先运行 `app install-fpk <localFile.fpk> --volume-id <volumeId> --dry-run --yes`。预演仍上传本地 FPK 供应用中心解析，随后读取安装信息并执行 CLI 安全检查，但不调用 `/app-center/v1/install/task`。

NAS 上已有的 FPK 使用 `app install-fpk --remote-path /vol.../*.fpk --dry-run --yes`。路径必须是具体 `/vol...` 路径、以 `.fpk` 结尾，远程文件不得大于 10GB。CLI 在创建应用中心远程软件包任务前检查远程文件属性。

安装或更新任务失败时，stderr 包含任务 ID、`appName`、`version`、`packageType`、安装/数据卷 ID、立即启动标记、状态/进度，以及后端 `message` 或 `outputText`。使用 `--cancel-on-failure` 时，stderr 还说明是否尝试取消以及取消是否失败。

已知存储错误在原始后端响应之外提供诊断。手动上传 FPK 时，`20001` 表示所选存储卷不可用；重试前选择已挂载且健康的卷 ID。

启动或停止返回 `10500` 时，表示应用中心不支持对当前应用状态/控制数据执行该状态操作。检查 `app status` 或使用应用中心界面。

运行 `app install` 时，若已知云应用来源标识，则传入 `--source-id`。`app update` 从已安装应用列表解析 `sourceID`。

CLI 拒绝以下需要应用中心界面决策的情况：

- 需要许可确认但未显式提供 `--accept-license`
- 需要自定义安装/更新向导参数但未显式提供 `--custom-parameters`
- 需要自定义卸载向导参数
- 安装类型不是受支持的 `volume` 或 `root`
- 安装/更新所需的 Docker 不可用或未初始化
- 操作系统版本不匹配
- 需要安装、更新或启动依赖应用
- 停止/卸载会影响运行中的依赖应用

支持根目录安装的软件包：安装卷发送 `0`，数据卷保持所选卷，与应用中心行为一致。

卸载会等待应用从已安装列表中消失，避免后端仍在移除旧安装时启动后续安装。

## 失败处理矩阵

| 条件 | CLI 行为 | 处理方式 |
| --- | --- | --- |
| 需要许可确认但缺少 `--accept-license` | 在安装/更新任务前拒绝 | 审阅许可后才传入 `--accept-license`，或使用应用中心界面 |
| 需要自定义安装/更新向导参数但缺少 `--custom-parameters` | 在安装/更新任务前拒绝 | 显式提供向导 JSON 或使用应用中心界面 |
| 需要自定义卸载向导参数 | 在卸载任务前拒绝 | 使用应用中心界面 |
| 安装类型不受支持 | 在安装/更新任务前拒绝 | 使用应用中心界面 |
| Docker 不可用或未初始化 | 在安装/更新任务前拒绝 | 修复 Docker 或使用应用中心界面 |
| 操作系统版本不兼容 | 在安装/更新/启动任务前拒绝 | 选择兼容的应用或操作系统版本 |
| 需要变更依赖应用 | 在安装/更新/启动任务前拒绝 | 在应用中心界面审阅依赖操作 |
| 会影响运行中的依赖应用 | 拒绝停止/卸载，并在适用时拒绝安装/更新 | 在应用中心界面停止/检查依赖应用 |
| 云端下载失败 | 报告云端下载任务 ID 及应用/版本/来源/卷上下文 | 检查 sourceID、版本、网络和应用中心可用性 |
| 使用 `--cancel-on-failure` 时安装/更新任务失败 | 报告任务失败上下文并尝试对应取消端点 | 查看 stderr 中的取消结果，必要时在应用中心确认任务状态 |
| 云端安装/更新预演通过 | 显示成功消息，不启动安装/更新任务 | 检查应用/版本/软件包/卷后再去掉 `--dry-run` 执行 |
| FPK 上传失败 | 报告上传任务 ID 和上传上下文 | 检查软件包有效性和目标卷 |
| FPK 上传返回 `20001` | 报告存储不可用诊断及原始响应 | 检查所选卷是否存在、已挂载且健康 |
| FPK 预演通过 | 输出 JSON 计划，不启动安装任务 | 检查应用/版本/软件包/卷后再去掉 `--dry-run` 执行 |
| 远程 FPK 路径或大小无效 | 在应用中心下载任务前拒绝 | 使用具体 `/vol.../*.fpk` 路径和不大于 10GB 的文件 |
| 缺少默认安装卷 | 在下载/安装任务前拒绝 | 传入 `--volume-id` 或配置应用中心默认下载/安装卷 |
| `set-sys` 字段校验失败 | 在网络请求前拒绝 | 修正字段类型、枚举、卷 ID 或更新时间窗口 |
| 安装/更新任务失败 | 报告任务 ID 及应用/版本/软件包/卷/状态/进度/后端消息 | 根据上下文定位软件包、版本、卷或后端脚本故障 |
| 启动/停止返回 `10500` | 报告状态操作诊断及原始响应 | 检查 `app status` 或使用应用中心界面 |
| 卸载后应用未从已安装列表消失 | 超时并报告应用名 | 检查应用中心界面或等待后端任务结束后重试 |

## 示例

```bash
./scripts/fnos-cli app list
./scripts/fnos-cli app status trim.alist
./scripts/fnos-cli app store list
./scripts/fnos-cli app store search alist
./scripts/fnos-cli app store detail trim.alist --source-id 265 --version 3.0.13
./scripts/fnos-cli app store latest-release
./scripts/fnos-cli app check-update
./scripts/fnos-cli app check-update --post --yes
./scripts/fnos-cli app common volume
./scripts/fnos-cli app common volume --set 2 --yes
./scripts/fnos-cli app config sys
./scripts/fnos-cli app config detail trim.alist
./scripts/fnos-cli app service list
./scripts/fnos-cli app entry list --only-hidden
./scripts/fnos-cli app desktop list
./scripts/fnos-cli app config set-sys --fields '{"autoRunNewApp":true}' --yes
./scripts/fnos-cli app config set trim.alist --fields '{"services":[],"extraAuthorizationPath":[]}' --yes
./scripts/fnos-cli app config auto-update trim.alist --enable --yes
./scripts/fnos-cli app config proxy-access trim.alist --allowed --yes
./scripts/fnos-cli app config post-wizard trim.alist --fields '{"customParameters":[]}' --yes
./scripts/fnos-cli app guide check-installed trim.photos trim.alist
./scripts/fnos-cli app guide batch-download-install 2 trim.photos trim.alist --yes
./scripts/fnos-cli app operation settings
./scripts/fnos-cli app openapi app-detail trim.alist
./scripts/fnos-cli app openapi allow-user-auth-paths trim.alist
./scripts/fnos-cli app openapi add-user-auth-path trim.alist /vol1/1000/docs --yes
./scripts/fnos-cli app openapi add-user-auth-inherit-file trim.alist /vol1/1000/docs/file.txt --yes
./scripts/fnos-cli app sac app-store-list
./scripts/fnos-cli app task-status <taskId>
./scripts/fnos-cli app task-cancel <taskId> --yes
./scripts/fnos-cli app download cancel <downloadTaskId> --yes
./scripts/fnos-cli app install-cancel <taskId> --yes
./scripts/fnos-cli app update-cancel <taskId> --yes
./scripts/fnos-cli app install trim.alist --version 3.0.13 --source-id 265 --volume-id 2 --dry-run --yes
./scripts/fnos-cli app install trim.alist --version 3.0.13 --source-id 265 --volume-id 2 --yes
./scripts/fnos-cli app install trim.alist --version 3.0.13 --volume-id 2 --custom-parameters '[{"key":"port","value":8080}]' --api-scope '{"API.User.FileAccess":true}' --yes
./scripts/fnos-cli app install trim.alist --version 3.0.13 --volume-id 2 --accept-license --cancel-on-failure --yes
./scripts/fnos-cli app install-fpk ~/Downloads/demo.fpk --volume-id 2 --dry-run --yes
./scripts/fnos-cli app install-fpk ~/Downloads/demo.fpk --volume-id 2 --yes
./scripts/fnos-cli app update trim.alist --version 3.0.14 --volume-id 2 --dry-run --yes
./scripts/fnos-cli app update trim.alist --version 3.0.14 --volume-id 2 --yes
./scripts/fnos-cli app stop trim.alist --yes
./scripts/fnos-cli app start trim.alist --yes
./scripts/fnos-cli app uninstall trim.alist --yes
```
