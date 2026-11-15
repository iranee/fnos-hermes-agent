# log 模块

## 模块概述
日志中心模块，涵盖日志查询、模块枚举、日志清除、导出和归档策略管理。

## 模块约定
- 操作日志、审计日志和日志服务控制应区分处理。
- 当前 fnos-cli 实现的端点属于 `appcgi.eventlogger.common.*` 命名空间。

## 端点索引
- 已实现：
  - `appcgi.eventlogger.common.list`
  - `appcgi.eventlogger.common.moduleList`
  - `appcgi.eventlogger.common.clear`
  - `appcgi.eventlogger.common.export`
  - `appcgi.eventlogger.common.archive`（设置归档策略）
  - `appcgi.eventlogger.common.archive.get`（查询归档策略）
  - `appcgi.eventlogger.debuglog.copyStart`（开始复制诊断日志）
  - `appcgi.eventlogger.debuglog.copyStop`（取消复制诊断日志）
- 未实现：
  - `log.*`（旧版日志查询家族）

## 端点详情

### appcgi.eventlogger.common.list

#### 端点
`appcgi.eventlogger.common.list`

#### 用途
按页查询日志中心记录，支持按级别和模块过滤。

#### CLI 映射
```
fnos-cli logger list [--page <n>] [--page-size <n>] [--level <n>] [--module <n>] [--locale <locale>]
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | 请求体 | 是 | 字符串 | 端点选择器 | 固定值 | `appcgi.eventlogger.common.list` |
| `reqid` | 请求体 | 是 | 字符串 | 请求关联 ID | 每次请求生成 | `69ba...` |
| `pageSize` | 请求体 | 否 | 数值 | 每页条数 | 正整数 | `50` |
| `page` | 请求体 | 否 | 数值 | 页码 | 正整数 | `1` |
| `level` | 请求体 | 否 | 数值 | 日志级别过滤 | 数值型级别标识 | `3` |
| `module` | 请求体 | 否 | 数值 | 日志模块过滤 | 数值型模块标识 | `1` |
| `locale` | 请求体 | 否 | 字符串 | 语言/区域 | 影响返回文本的语言 | `zh-CN` |

#### 响应
| 字段 | 始终存在 | 类型 | 含义 | 条件 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- |
| `data` | 否 | 对象 | 日志数据 | 包含日志条目和分页信息 | `{...}` |
| `result` | 否 | 字符串 | 终态标记 | `succ`/`fail` | `succ` |
| `errno` | 否 | 数值 | 错误码 | 失败时出现 | `65534` |
| `errmsg` | 否 | 字符串 | 错误描述 | 失败时出现 | `invalid filter` |

### appcgi.eventlogger.common.moduleList

#### 端点
`appcgi.eventlogger.common.moduleList`

#### 用途
列出可用的日志模块。

#### CLI 映射
```
fnos-cli logger modules [--locale <locale>]
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | 请求体 | 是 | 字符串 | 端点选择器 | 固定值 | `appcgi.eventlogger.common.moduleList` |
| `reqid` | 请求体 | 是 | 字符串 | 请求关联 ID | 每次请求生成 | `69ba...` |
| `locale` | 请求体 | 否 | 字符串 | 语言/区域 | 影响模块名称的语言 | `zh-CN` |

### appcgi.eventlogger.common.clear

#### 端点
`appcgi.eventlogger.common.clear`

#### 用途
按日志级别和模块清空日志记录。

#### CLI 映射
```
fnos-cli logger clear --level <level> --module <module> --yes
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | 请求体 | 是 | 字符串 | 端点选择器 | 固定值 | `appcgi.eventlogger.common.clear` |
| `reqid` | 请求体 | 是 | 字符串 | 请求关联 ID | 每次请求生成 | `69ba...` |
| `level` | 请求体 | 是 | 数值 | 日志级别 | 必填 | `3` |
| `module` | 请求体 | 是 | 数值 | 日志模块 | 必填 | `1` |

### appcgi.eventlogger.common.export

#### 端点
`appcgi.eventlogger.common.export`

#### 用途
按日志级别和模块导出日志记录。

#### CLI 映射
```
fnos-cli logger export --level <level> --module <module> [--locale <locale>] --yes
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | 请求体 | 是 | 字符串 | 端点选择器 | 固定值 | `appcgi.eventlogger.common.export` |
| `reqid` | 请求体 | 是 | 字符串 | 请求关联 ID | 每次请求生成 | `69ba...` |
| `level` | 请求体 | 是 | 数值 | 日志级别 | 必填 | `3` |
| `module` | 请求体 | 是 | 数值 | 日志模块 | 必填 | `1` |
| `locale` | 请求体 | 否 | 字符串 | 语言/区域 | 影响导出内容的语言 | `zh-CN` |

### appcgi.eventlogger.common.archive

#### 端点
`appcgi.eventlogger.common.archive`

#### 用途
设置日志归档策略。

#### CLI 映射
```
fnos-cli logger archive set --switch <0|1> --file-path <path> [--size-gt <n>] [--date-unit <n>] [--date-before <n>] --yes
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | 请求体 | 是 | 字符串 | 端点选择器 | 固定值 | `appcgi.eventlogger.common.archive` |
| `reqid` | 请求体 | 是 | 字符串 | 请求关联 ID | 每次请求生成 | `69ba...` |
| `switch` | 请求体 | 是 | 数值 | 归档开关 | `0` 关闭，`1` 开启 | `1` |
| `filePath` | 请求体 | 是 | 字符串 | 归档文件路径 | 禁用归档时可传空字符串 | `/vol1/logs` |
| `sizeGt` | 请求体 | 否 | 数值 | 文件大小阈值 | 可选 | `1024` |
| `dateUnit` | 请求体 | 否 | 数值 | 日期单位 | `0` 天，`1` 周，`2` 月，`3` 年 | `2` |
| `dateBefore` | 请求体 | 否 | 数值 | 日期偏移量 | 可选 | `3` |

#### 字段语义
- `switch` 为 `0` 时表示关闭归档，此时 `filePath` 可传空字符串。
- `dateUnit` 定义时间粒度：`0` 天、`1` 周、`2` 月、`3` 年。

### appcgi.eventlogger.common.archive.get

#### 端点
`appcgi.eventlogger.common.archive.get`

#### 用途
查询当前日志归档配置。

#### CLI 映射
```
fnos-cli logger archive query
```

#### 协议说明
- 响应包含当前归档配置，CLI 直接打印后端返回的 payload。
- 响应中 `validPath` 字段（如存在）表示路径有效性状态。

### appcgi.eventlogger.debuglog.copyStart

#### 端点
`appcgi.eventlogger.debuglog.copyStart`

#### 用途
复制后端诊断日志（Debug Log）到指定输出目录，并返回任务进度。

#### CLI 映射
```
fnos-cli logger debuglog copy-start --output-dir <path> [--srv-type <0|1|2>]... --yes
fnos-cli diagnostic-log export --output-dir <path> [--srv-type <0|1|2>]... --yes
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | 请求体 | 是 | 字符串 | 端点选择器 | 固定值 | `appcgi.eventlogger.debuglog.copyStart` |
| `reqid` | 请求体 | 是 | 字符串 | 请求关联 ID | 每次请求生成 | `69ba...` |
| `outputDir` | 请求体 | 是 | 字符串 | 输出目录 | CLI 要求已挂载存储空间或外挂盘路径，格式如 `/vol1/<dir>` 或 `/vol00/<mount>/<dir>`；不要使用系统目录如 `/tmp`、`/var/tmp`、`/home/...` | `/vol00/RemovableDisk/debug-log` |
| `srvType` | 请求体 | 否 | 数值数组 | 复制类别 | `0` 系统，`1` 内置应用，`2` 内置服务；未传时后端按全部类别处理。CLI 支持重复传入或逗号分隔，并按顺序去重。 | `[0,1,2]` |

#### 响应
| 字段 | 始终存在 | 类型 | 含义 | 条件 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- |
| `taskId` | 否 | 字符串 | 复制任务 ID | doing/success 进度帧的 `data` 中返回 | `ftask_1` |
| `fileNumTotal` | 否 | 数值 | 需要复制的文件总数 | 进度帧返回 | `51` |
| `fileNumDone` | 否 | 数值 | 已复制文件数 | 进度帧返回 | `2` |

#### 协议说明
- 后端可能先返回 `result:"doing"` 进度帧，再返回终态帧。CLI 会优先展示带 `taskId` 的进度 payload，方便后续执行 `diagnostic-log stop`。
- `outputDir` 必须预先存在于设备侧已挂载的存储空间或外挂盘下。普通存储常见路径是 `/volN/<uid>/...`；外挂盘常见路径是 `/vol00/<mount-name>/...`。

#### 错误
- 常见错误包括缺少 `outputDir`、目录不存在、创建目录失败、目录不可写、磁盘空间不足、重复任务、任务不存在等。

### appcgi.eventlogger.debuglog.copyStop

#### 端点
`appcgi.eventlogger.debuglog.copyStop`

#### 用途
取消正在进行的诊断日志复制任务。

#### CLI 映射
```
fnos-cli logger debuglog copy-stop --task-id <taskId> --yes
fnos-cli diagnostic-log stop --task-id <taskId> --yes
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | 请求体 | 是 | 字符串 | 端点选择器 | 固定值 | `appcgi.eventlogger.debuglog.copyStop` |
| `reqid` | 请求体 | 是 | 字符串 | 请求关联 ID | 每次请求生成 | `69ba...` |
| `taskId` | 请求体 | 是 | 字符串 | 复制任务 ID | CLI 要求非空且不包含空白字符 | `ftask_1` |

## 注意事项
- 旧版 `log.*` 家族端点和当前 `appcgi.eventlogger.common.*` 端点可能在不同固件版本上共存。
- `logger debuglog copy-start` / `diagnostic-log export` 的 `outputDir` 需要选择已挂载存储空间或外挂盘路径；系统盘路径不是有效诊断日志导出目标。
