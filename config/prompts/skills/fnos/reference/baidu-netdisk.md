# 百度网盘模块

## 模块概述

`baidu-netdisk` 通过 fnOS HTTP API proxy 访问 NAS 上已经安装的百度网盘应用。它覆盖百度账号授权状态、网盘空间、云端文件操作、百度分享链接保存、NAS 与网盘之间的传输任务，以及定时同步任务。

fnOS OAuth session 必须包含 `trim.baidu_netdisk.all`。旧 session 缺少该权限时需重新执行
`login`，refresh token 无法扩大原授权范围。

目标 fnOS 的 OAuth gateway 还必须把 `/app-baidu-netdisk` 的 HTTP 路由登记到该 scope。
授权页能勾选百度网盘权限不代表路由已经登记；路由未登记时请求会在到达应用前返回 HTTP 403。

CLI 不实现百度 OAuth。百度账号未授权或授权失效时，必须由用户在 NAS 的百度网盘应用登录页完成授权，然后重新运行 `status`。

## 模块约定

- 先完成 fnOS 的 `fnos-cli login`，再调用本模块。
- 百度网盘路径必须以一个 `/` 开头；根路径是 `/`。
- NAS 写入或读取路径必须是具体 `/vol{n}/...` 路径，不能用聚合根或百度网盘路径代替。
- 所有写命令都要求 `--yes`。只读命令不要求确认。
- 后端响应成功条件是 HTTP 2xx 且 `code=0`；百度 XPan 响应成功条件是 HTTP 2xx 且 `errno=0`。
- 网关刷新重试后仍为 HTTP 401，或响应为 `code=401`、`code=2000`、`errno=-6`，表示百度授权不可用，应回到 NAS 应用登录页处理。
- HTTP 403 表示 fnOS gateway 拒绝了应用路由。先核对 session 是否含 `trim.baidu_netdisk.all`，再确认设备上的 gateway 版本是否已登记 `/app-baidu-netdisk` 路由；不要误判为百度账号退出。
- `dlink` 是敏感临时下载 URL，默认输出会脱敏。

## 命令索引

| 命令 | 类型 | 用途 |
| --- | --- | --- |
| `baidu-netdisk status` | 读 | 检查应用账号、百度账号和设备权益状态 |
| `baidu-netdisk quota` | 读 | 查看总空间、已用空间和免费空间 |
| `baidu-netdisk ls [dir]` | 读 | 浏览目录 |
| `baidu-netdisk search <keyword>` | 读 | 搜索文件 |
| `baidu-netdisk info <fsid...>` | 读 | 获取文件元数据 |
| `baidu-netdisk mkdir <path>` | 写 | 创建目录 |
| `baidu-netdisk rm <path...>` | 写 | 删除文件或目录 |
| `baidu-netdisk rename <path> <newName>` | 写 | 重命名 |
| `baidu-netdisk move <path...> <destDir>` | 写 | 移动，最后一个参数是目标目录 |
| `baidu-netdisk copy <path...> <destDir>` | 写 | 复制，最后一个参数是目标目录 |
| `baidu-netdisk upload <targetPath> <localPath...>` | 写 | 从 NAS 上传到网盘 |
| `baidu-netdisk download <targetPath> <fsid...>` | 写 | 从网盘下载到 NAS |
| `baidu-netdisk share-save <shareUrl> <targetPath>` | 写 | 把百度分享链接内容保存到 NAS |
| `baidu-netdisk task ...` | 读/写 | 查询和控制传输任务 |
| `baidu-netdisk sync ...` | 读/写 | 查询和管理同步任务 |

## 授权、空间和文件读取

### `status`

```bash
fnos-cli baidu-netdisk status
```

返回数据包括：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `authorized` | boolean | 三段授权状态请求均成功时为 `true` |
| `authorizationPath` | string | NAS 应用授权入口路径 |
| `appUser.uk` | number | 应用侧百度用户标识 |
| `appUser.deviceId` | string | NAS 应用绑定的百度设备 ID |
| `baiduUser.baidu_name` | string | 百度账号名 |
| `baiduUser.netdisk_name` | string | 网盘显示名 |
| `baiduUser.vip_type` | number | `0` 普通、`1` VIP、`2` SVIP |
| `iot.is_iot_svip` | number | NAS 设备权益状态，`1` 有效、`0` 无效 |

### `quota`

```bash
fnos-cli baidu-netdisk quota
```

响应常见字段：`total`、`used`、`free`，单位均为 byte；`expire` 表示近期容量到期状态。

### `ls`

```bash
fnos-cli baidu-netdisk ls [dir] [--order name|size|time|ctime|path] [--ascending] [--page N] [--limit N]
```

| 选项 | 必填 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `dir` | 否 | `/` | 百度网盘目录 |
| `--order` | 否 | `time` | 排序字段 |
| `--ascending` | 否 | false | 升序；缺省为降序 |
| `--page` | 否 | `1` | 页码，从 1 开始 |
| `--limit` | 否 | `80` | 每页数量，范围 1 到 1000 |

文件条目常见字段：`fs_id`、`path`、`server_filename`、`isdir`、`category`、`size`、`server_mtime`、`server_ctime`、`thumbs`。

### `search`

```bash
fnos-cli baidu-netdisk search <keyword> [--dir /] [--category video|audio|image|document|application|other|seed] [--recursive] [--limit N]
```

响应的 `list[]` 使用与 `ls` 相同的文件字段；`has_more=1` 表示仍有后续结果。

### `info`

```bash
fnos-cli baidu-netdisk info <fsid...> [--dlink]
```

`fsid` 必须是正整数。`--dlink` 请求临时下载地址，但 CLI 会对响应中的 `dlink` 值脱敏；该命令适合检查元数据，不适合导出裸下载链接。

## 云端文件写操作

```bash
fnos-cli baidu-netdisk mkdir <path> --yes
fnos-cli baidu-netdisk rm <path...> --yes
fnos-cli baidu-netdisk rename <path> <newName> --yes
fnos-cli baidu-netdisk move <path...> <destDir> [--ondup fail|newcopy|overwrite|skip] --yes
fnos-cli baidu-netdisk copy <path...> <destDir> [--ondup fail|newcopy|overwrite|skip] --yes
```

| 字段 | 位置 | 含义 | 约束 |
| --- | --- | --- | --- |
| `path` | 位置参数 | 源文件或目录 | 绝对网盘路径，不允许 `.` / `..` 段 |
| `newName` | 位置参数 | 新名称 | 单个名称，不能包含 `/` 或 `\\` |
| `destDir` | 最后一个位置参数 | 目标目录 | `move/copy` 的最后一个参数 |
| `--ondup` | 选项 | 重名策略 | `fail` 失败、`newcopy` 保留副本、`overwrite` 覆盖、`skip` 跳过 |

文件管理响应可能包含 `taskid` 和逐项 `info[]`；即使顶层 `errno=0`，也应检查逐项 `info[].errno`。

## NAS 与网盘传输

### 创建任务

```bash
fnos-cli baidu-netdisk upload <targetPath> <localPath...> [--conflict fail|rename|overwrite] --yes
fnos-cli baidu-netdisk download <targetPath> <fsid...> [--conflict fail|rename|overwrite] --yes
```

| 字段 | 命令 | 含义 | 约束 |
| --- | --- | --- | --- |
| `targetPath` | upload | 百度网盘目标目录 | `/` 开头的网盘路径 |
| `localPath` | upload | NAS 源路径 | 一个或多个 `/vol{n}/...` 路径 |
| `targetPath` | download | NAS 目标目录 | 具体 `/vol{n}/...` 路径 |
| `fsid` | download | 百度文件 ID | 一个或多个正整数 |
| `--conflict` | 两者 | 冲突策略 | `fail=0`、`rename=1`、`overwrite=3` |

`uploadToCloud` 成功响应按应用合约返回 `data: null`。CLI 会输出结构化的任务提交确认，
包括 `accepted: true`、`status: "submitted"`、目标路径、NAS 源路径、冲突策略和后端消息，
不会把裸 `null` 当作结果，也不会声称传输已经完成。要查看进度或失败原因，继续执行：

```bash
fnos-cli baidu-netdisk task list --transfer upload --state running
fnos-cli baidu-netdisk task list --transfer upload --state completed
fnos-cli baidu-netdisk task info <taskId> --state completed
```

`task list/info` 默认查询 `running`。这里的 `running` 是应用定义的“未完成任务组”，会包含排队、等待、进行中、暂停和失败任务，因此返回 `status=6` 不是过滤失效。`completed` 组只包含 `status=5` 的已完成任务。

建议在上传大文件前先执行 `baidu-netdisk quota` 检查剩余空间。任务进入 `status=6` 且
`failCode=42610` 时，表示百度网盘空间不足；这说明提交接口已经创建任务，但异步传输失败。
先释放百度网盘空间或扩容，再重新提交，不要把它误判为 CLI、OAuth 或网关失败。

### 保存百度分享链接

```bash
fnos-cli baidu-netdisk share-save '<shareUrlWithPassword>' /vol1/1000/downloads --all --yes
fnos-cli baidu-netdisk share-save '<shareUrl>' /vol1/1000/downloads --password <code> --fsid <id> [--fsid <id>...] --yes
```

- `shareUrl` 可传百度分享 URL、22 位分享短码，也可粘贴带“提取码: xxxx”的整段文本；URL 中的 `?pwd=xxxx` 也会自动识别。显式 `--password` 优先。
- 分享域名必须是 `pan.baidu.com` 或 `yun.baidu.com`；NAS 目标必须是具体 `/vol{n}/...` 目录。
- `--all` 保存分享根目录中的全部条目；若根条目是目录，百度会递归转存。需要精确选择且已知分享 fsid 时，改为重复传 `--fsid`。两种选择模式不能同时使用。
- 命令先把选中条目转存到百度网盘固定目录 `/我的资源`，轮询完成后再创建下载到 NAS 的任务；百度端重名保留副本，NAS 端重名自动改名。
- 命令最多等待百度转存 30 分钟。成功只表示 NAS 下载任务已创建，之后用 `baidu-netdisk task list --transfer download` 查看是否完成。
- 分享短码、提取码、验证后的 `spwd`、分享 fsid 和中间任务 ID 都不会写入正常输出；Agent 也不得在回复或日志中回显这些值。

### 查询任务

```bash
fnos-cli baidu-netdisk task list --transfer upload|download [--state running|completed] [--page N] [--page-size N] [--sort-by name|size|status] [--ascending]
fnos-cli baidu-netdisk task info <taskId> [--state running|completed] [--page N] [--page-size N] [--sort-by name|size|status] [--ascending]
```

任务字段常见为：`id`、`name`、`targetPath`、`savePath`、`size`、`currentSize`、`speed`、`count`、`status`、`failCode`、`createdAt`、`updatedAt`。状态值：`0` 排队、`1` 等待、`3` 进行中、`4` 暂停、`5` 完成、`6` 失败。失败任务必须同时读取 `failCode`；其中 `42610` 表示百度网盘空间不足。

### 控制任务

```bash
fnos-cli baidu-netdisk task pause <taskId...> --yes
fnos-cli baidu-netdisk task resume <taskId...> --yes
fnos-cli baidu-netdisk task cancel <taskId...> --yes
fnos-cli baidu-netdisk task clear [--transfer upload|download] --yes
```

`clear` 只清理已完成任务。未指定 `--transfer` 时，CLI 依次清理上传和下载任务，并分别返回结果。

## 同步任务

```bash
fnos-cli baidu-netdisk sync list
fnos-cli baidu-netdisk sync create --direction download|upload --nas-path /vol1/... --netdisk-path /... [--interval 1m|10m|30m] [--conflict fail|rename|overwrite] [--immediate] [--keep-deleted] [--status running|paused] --yes
fnos-cli baidu-netdisk sync update <id> --status running|paused --interval 1m|10m|30m --conflict fail|rename|overwrite [--immediate] --yes
fnos-cli baidu-netdisk sync start|pause|delete <id> --yes
```

| 字段 | API 值 | 含义 |
| --- | --- | --- |
| `direction=download` | `1` | 百度网盘同步到 NAS |
| `direction=upload` | `2` | NAS 同步到百度网盘 |
| `interval=1m/10m/30m` | `1/2/3` | 同步执行频率 |
| `status=running/paused` | `1/2` | 任务状态 |
| `--immediate` | `allSyncRightNow=true` | 保存配置后立即全量同步 |
| `--keep-deleted` | `dontFollowDeleted=true` | 来源删除后保留目的地文件，仅创建时设置 |

同步任务常见响应字段：`id`、`direction`、`nasPath`、`netdiskPath`、`intervalType`、`dontFollowDeleted`、`allSyncRightNow`、`status`、`createdAt`、`updatedAt`。

## 错误与停手条件

- fnOS session 缺失或目标 NAS 不匹配：先重新执行 `fnos-cli login`，不要改用百度账号密码。
- 百度授权错误：让用户在 NAS 百度网盘应用页面重新授权，然后重试只读 `status`。
- HTTP 502 通常表示 NAS 上的百度网盘应用未安装、未启动或网关上游不可达；这是服务可用性问题，不应重试成空结果。先用 `app list` 确认应用，再检查应用状态。
- HTTP 非 2xx、后端 `code != 0`、XPan `errno != 0`：保留响应中的 `msg`、`errmsg` 或 `show_msg`，不要只按退出码判断。
- 路径校验失败：先确认它是百度网盘路径还是 NAS `/vol{n}/...` 路径，不要自动改写。
- 分享保存失败：不要跳过验证、轮询或直接拼接下载链接；先根据 `errno` 区分链接失效、提取码错误、无权转存、选中文件无效或任务超限。
- 写操作没有 `--yes`：停下请求确认，不要绕过门禁。
