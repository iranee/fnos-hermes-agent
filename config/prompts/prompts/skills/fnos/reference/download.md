# download 模块

## 模块概述
下载中心模块，映射到 `appcgi.downloadcenter.*` 命名空间。支持通过 URL/磁力链接/种子文件创建下载任务，以及任务查询、控制和统计。

下载中心请求使用与其他 CGI 调用相同的 `{ req, reqid, ...params }` 格式，但部分端点通过 `data.rsp`、`data.body` 或 `data.block.data` 返回业务数据。

## 协议模型

### 请求模型

典型请求格式：

```json
{
  "reqid": "250318103000ABCDEF0123456789ABCD",
  "req": "appcgi.downloadcenter.task.query",
  "init_flag": true,
  "state_filter": 65535
}
```

注意事项：
- 部分参数在 API 层使用 camelCase（如 `initFlag`），但 CGI 层使用 snake_case（如 `init_flag`）
- 多数端点接受可选 `uid` 参数
- `task.addUris` 的 `save_dir` 在实际使用中是必需的

### 响应模型

响应数据可能嵌套在不同位置：

```json
{
  "reqid": "...",
  "result": "succ",
  "req": "appcgi.downloadcenter.task.query",
  "data": {
    "block": {
      "id": "20260318160514HlEnuPgC19HGBlXP",
      "total_size": 41653,
      "offset": 0,
      "data": "{\"tasks\":[],\"stats\":{}}"
    }
  }
}
```

业务数据可能位于 `data.rsp`、`data.body` 或 `data.block.data`（JSON 字符串需解码）。

### 终态和错误处理

终态值：`succ`、`fail`、`cancel`

处理规则：
- 传输完成和业务成功是独立关注点
- 保留 `errno`、`errmsg` 和 `extra`
- 部分控制类端点成功时返回简单的 `"ok"`
- 部分端点返回 `{ code: 200, body: {} }` 格式
- 批量创建端点可能返回 `errs[]`（即使请求本身成功）

### 大块传输

- 单包不超过 1 MiB
- 大载荷使用相同 `reqid` 分块传输
- 响应包含 `block.id`、`block.total_size`、`block.offset`、`block.data`

## 端点索引

### 查询类（已实现）
- `appcgi.downloadcenter.task.query` — 任务列表和统计
- `appcgi.downloadcenter.task.search` — 关键字搜索
- `appcgi.downloadcenter.task.getInfo` — 任务详情
- `appcgi.downloadcenter.task.getFiles` — 任务文件列表

### 创建类（已实现）
- `appcgi.downloadcenter.task.addUris` — 从 URL/磁力链接创建
- `appcgi.downloadcenter.task.addPaths` — 从 NAS 上的种子文件创建

### 控制类（已实现）
- `appcgi.downloadcenter.task.pause` — 暂停任务
- `appcgi.downloadcenter.task.resume` — 恢复任务
- `appcgi.downloadcenter.task.retry` — 重试任务
- `appcgi.downloadcenter.task.delete` — 删除任务

### 统计类（已实现）
- `appcgi.downloadcenter.stat.all` — 汇总统计

### 泛化请求入口

未封装为固定子命令的 `appcgi.downloadcenter.*` 端点通过以下入口调用：

```bash
fnos-cli download request appcgi.downloadcenter.<name> --json '<object>' --yes
```

- `--json` 必须是 JSON object，不能包含 `req` 或 `reqid`，CLI 会自动注入。
- 默认需要交互确认；自动化或确认过风险后用 `--yes`。
- 响应会按下载中心常见位置解包：`data.rsp`、`data.body`、`data.block.data`。

通过 `download request` 覆盖的端点包括：
- 创建类：`task.addfnShareLink`、`task.getfnShareLinkStatus`
- 控制类：`task.pin`、`task.setForceStart`、`task.setFilePriority`、`task.exportTorrentFile`、`task.setDownloadLimit`、`task.setUploadLimit`、`task.setShareLimit`
- 配置类：`config.getDefaultSaveDir`、`config.setDefaultSaveDir`、`config.getTransferCfg`、`config.setTransferCfg`、`config.getNetworkCfg`、`config.setNetworkCfg`、`config.getAltCfg`、`config.setAltCfg`、`config.getListColumns`、`config.setListColumns`
- 统计类：`stat.qbittorrent`、`stat.aria2`
- Tracker 类：`task.getTrackers`、`task.addTrackers`、`task.removeTrackers`、`task.editTracker`、`tracker.query`、`tracker.insert`、`tracker.delete`
- Peer 类：`task.getPeers`、`task.addPeers`、`transfer.banPeers`
- 扫描目录：`scanDir.query`、`scanDir.insert`、`scanDir.delete`
- 工具类：`util.getDirFreeSpace`、`util.isTcpPortInUse`
- 管理员：`admin.getUsers`

`task.addUploadFile` 涉及上传文件内容和大块传输，不是普通 JSON 参数请求；优先使用文件上传相关命令完成本地文件上传后，再按设备行为调用下载中心端点。

## 端点详情

### appcgi.downloadcenter.task.query

#### 端点
`appcgi.downloadcenter.task.query`

#### 用途
查询任务列表、聚合统计和下载引擎错误信息。

#### CLI 映射
```
fnos-cli download ls
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | 请求体 | 是 | string | 端点选择器 | 固定值 | `appcgi.downloadcenter.task.query` |
| `reqid` | 请求体 | 是 | string | 请求关联 ID | 逐请求生成 | `69ba...` |
| `engine_types` | 请求体 | 否 | array | 引擎类型过滤 | 可选 | `[1,2]` |
| `ids` | 请求体 | 否 | array | 指定任务 ID | 可选 | `[42,43]` |
| `state_filter` | 请求体 | 否 | number | 状态过滤掩码 | CLI 默认 `65535`（所有状态） | `65535` |
| `type_filter` | 请求体 | 否 | number | 类型过滤 | 可选 | `1` |
| `init_flag` | 请求体 | 否 | boolean | 初始化标志 | CLI 默认 `true` | `true` |
| `uid` | 请求体 | 否 | number | 用户 ID | 可选 | `1000` |

#### 响应
主要响应字段（位于 `data.block.data` 解码后）：

| 字段 | 总是存在 | 类型 | 含义 | 条件 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- |
| `tasks` | 否 | array | 任务列表 | 包含任务摘要信息 | `[...]` |
| `stats` | 否 | object | 聚合统计 | 速度和大小统计 | `{...}` |
| `errors` | 否 | array | 引擎错误 | 下载引擎报告的错误 | `[...]` |

常见任务字段：`id`、`type`、`name`、`state`、`total_size`、`size`、`dl_speed`、`up_speed`、`save_dir`、`uri`、`addition_time`、`error_code`、`error_message`

### appcgi.downloadcenter.task.search

#### 端点
`appcgi.downloadcenter.task.search`

#### 用途
按任务名或文件名搜索下载任务。

#### CLI 映射
```
fnos-cli download ls <keyword>
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | 请求体 | 是 | string | 端点选择器 | 固定值 | `appcgi.downloadcenter.task.search` |
| `reqid` | 请求体 | 是 | string | 请求关联 ID | 逐请求生成 | `69ba...` |
| `keyword` | 请求体 | 是 | string | 搜索关键字 | 按任务名或文件名匹配 | `ubuntu` |
| `uid` | 请求体 | 否 | number | 用户 ID | 可选 | `1000` |

### appcgi.downloadcenter.task.getInfo

#### 端点
`appcgi.downloadcenter.task.getInfo`

#### 用途
获取单个下载任务的详细信息。

#### CLI 映射
```
fnos-cli download info <id>
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | 请求体 | 是 | string | 端点选择器 | 固定值 | `appcgi.downloadcenter.task.getInfo` |
| `reqid` | 请求体 | 是 | string | 请求关联 ID | 逐请求生成 | `69ba...` |
| `id` | 请求体 | 是 | number | 任务 ID | 正整数 | `42` |
| `uid` | 请求体 | 否 | number | 用户 ID | 可选 | `1000` |

#### 响应
主要响应字段（位于 `body` 中）：

| 字段 | 总是存在 | 类型 | 含义 | 条件 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- |
| `name` | 否 | string | 任务名称 | | `ubuntu-22.04.iso` |
| `total_size` | 否 | number | 总大小（bytes） | | `4194304` |
| `save_path` | 否 | string | 保存路径 | | `/vol1/downloads` |
| `dl_speed` | 否 | number | 下载速度 | | `1048576` |
| `up_speed` | 否 | number | 上传速度 | | `0` |
| `eta` | 否 | number | 预计剩余时间 | | `120` |
| `seeds` | 否 | number | 种子数 | | `5` |
| `peers` | 否 | number | 对等节点数 | | `12` |
| `share_ratio` | 否 | number | 分享比 | | `0.5` |
| `addition_date` | 否 | number | 添加时间 | | `1710000000` |
| `completion_date` | 否 | number | 完成时间 | | `1710100000` |

### appcgi.downloadcenter.task.getFiles

#### 端点
`appcgi.downloadcenter.task.getFiles`

#### 用途
获取下载任务的文件列表，对 BT 类任务尤其有用。

#### CLI 映射
```
fnos-cli download files <id>
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | 请求体 | 是 | string | 端点选择器 | 固定值 | `appcgi.downloadcenter.task.getFiles` |
| `reqid` | 请求体 | 是 | string | 请求关联 ID | 逐请求生成 | `69ba...` |
| `id` | 请求体 | 是 | number | 任务 ID | 正整数 | `42` |
| `mode` | 请求体 | 否 | number | 获取模式 | `1` 表示立即获取 | `1` |
| `uid` | 请求体 | 否 | number | 用户 ID | 可选 | `1000` |

#### 响应
主要响应字段（位于 `body[]` 中）：

| 字段 | 总是存在 | 类型 | 含义 | 条件 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- |
| `index` | 否 | number | 文件序号 | | `0` |
| `name` | 否 | string | 文件名 | | `readme.txt` |
| `size` | 否 | number | 文件大小 | | `1024` |
| `progress` | 否 | number | 下载进度 | | `0.75` |
| `priority` | 否 | number | 优先级 | `0` 不下载，`1` 正常，`7` 最高 | `1` |

### appcgi.downloadcenter.task.addUris

#### 端点
`appcgi.downloadcenter.task.addUris`

#### 用途
从 URL 或磁力链接创建下载任务。

#### CLI 映射
```
fnos-cli download add-uri <uri> <saveDir> --yes
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | 请求体 | 是 | string | 端点选择器 | 固定值 | `appcgi.downloadcenter.task.addUris` |
| `reqid` | 请求体 | 是 | string | 请求关联 ID | 逐请求生成 | `69ba...` |
| `uris` | 请求体 | 是 | string[] | URI 列表 | 支持 http/https/ftp/sftp/magnet | `["magnet:?xt=..."]` |
| `save_dir` | 请求体 | 是 | string | 保存目录 | 必须为 `/vol{v}/...` 格式 | `/vol1/downloads` |
| `select_files` | 请求体 | 否 | array | 选择文件 | BT 类输入时有意义 | `[0,1,2]` |
| `uris_type` | 请求体 | 否 | number | URI 类型 | `0` 默认，`1` qBittorrent | `0` |

#### 响应
| 字段 | 总是存在 | 类型 | 含义 | 条件 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- |
| `ids` | 否 | number[] | 创建的任务 ID | | `[42]` |
| `errs` | 否 | array | 逐项错误 | 请求成功但部分项失败时出现 | `[{"uri":"...","err":"..."}]` |

### appcgi.downloadcenter.task.addPaths

#### 端点
`appcgi.downloadcenter.task.addPaths`

#### 用途
从 NAS 上已有的种子文件创建下载任务。

#### CLI 映射
```
fnos-cli download add-path <path> <saveDir> --yes
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | 请求体 | 是 | string | 端点选择器 | 固定值 | `appcgi.downloadcenter.task.addPaths` |
| `reqid` | 请求体 | 是 | string | 请求关联 ID | 逐请求生成 | `69ba...` |
| `paths` | 请求体 | 是 | string[] | 种子文件路径列表 | 必须为 `/vol{v}/...` 格式 | `["/vol1/torrents/demo.torrent"]` |
| `save_dir` | 请求体 | 是 | string | 保存目录 | 必须为 `/vol{v}/...` 格式 | `/vol1/downloads` |
| `select_files` | 请求体 | 否 | array | 选择文件 | 可选 | `[0,1]` |

#### 响应
| 字段 | 总是存在 | 类型 | 含义 | 条件 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- |
| `ids` | 否 | number[] | 创建的任务 ID | | `[43]` |
| `errs` | 否 | array | 逐项错误 | 请求成功但部分项失败时出现 | `[...]` |

### 控制类端点

#### appcgi.downloadcenter.task.pause / resume / retry / delete

这四个端点共享相同的请求结构。

#### CLI 映射
```
fnos-cli download pause <id...> --yes
fnos-cli download resume <id...> --yes
fnos-cli download retry <id...> --yes
fnos-cli download rm <id...> --yes
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | 请求体 | 是 | string | 端点选择器 | 对应具体操作 | `appcgi.downloadcenter.task.pause` |
| `reqid` | 请求体 | 是 | string | 请求关联 ID | 逐请求生成 | `69ba...` |
| `ids` | 请求体 | 是 | number[] | 任务 ID 列表 | 支持批量操作 | `[42, 43]` |
| `uid` | 请求体 | 否 | number | 用户 ID | 可选 | `1000` |
| `delete_files` | 请求体 | 否 | boolean | 是否同时删除文件 | 仅 `delete` 端点可用；CLI 默认不删除文件 | `false` |

#### 响应
成功时通常返回 `"ok"`。

### appcgi.downloadcenter.stat.all

#### 端点
`appcgi.downloadcenter.stat.all`

#### 用途
获取下载中心的汇总统计信息。

#### CLI 映射
```
fnos-cli download stat
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | 请求体 | 是 | string | 端点选择器 | 固定值 | `appcgi.downloadcenter.stat.all` |
| `reqid` | 请求体 | 是 | string | 请求关联 ID | 逐请求生成 | `69ba...` |
| `uid` | 请求体 | 否 | number | 用户 ID | 可选 | `1000` |

#### 响应
| 字段 | 总是存在 | 类型 | 含义 | 条件 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- |
| `dl_speed` | 否 | number | 总下载速度 | | `1048576` |
| `dl_total_size` | 否 | number | 总下载量 | | `10737418240` |
| `up_speed` | 否 | number | 总上传速度 | | `524288` |
| `up_total_size` | 否 | number | 总上传量 | | `5368709120` |

## 注意事项
- 文件上传（`task.addUploadFile`）需要上传内容和大块传输支持，不应当作普通 `download request --json` 调用。
- `task.addfnShareLink` 是下载中心的导入任务端点，不要与 `appcgi.sharesvr.share.link.*` 的共享链接管理端点混淆。
- 部分响应数据的具体字段结构可能因后端版本而异。
