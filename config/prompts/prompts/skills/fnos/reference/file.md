# file 模块

## 模块概述
文件系统操作模块，涵盖文件列表、目录创建、删除、复制、移动、finder 搜索、共享目录/ACL 流程、传输任务、回收站、收藏夹、最近文件和团队文件操作。

## 模块约定
- 路径约束：必须使用 规范 fnOS 路径格式 `/vol{v}/...`，聚合根行为需在端点说明中明确标注。
- 列表/搜索类端点可能使用流式响应（多包），需明确标注终态判定规则。
- `file.share.*` 共享目录端点属于本模块；`appcgi.sharesvr.share.link.*` 共享链接管理属于单独的 share 模块。

## 任务路由

先按用户意图选命令，再看后面的端点详情：

| 用户意图 | 优先命令 | 说明 |
| --- | --- | --- |
| 看当前可见目录 | `fnos-cli file ls` | 无参数和 `/` 都是省略 `path` 的模式 |
| 看某个具体目录 | `fnos-cli file ls /vol{v}/...` | 只接受 规范 路径 |
| 搜当前用户目录下的文件 | `fnos-cli file search <key>` | CLI 会先探测再推导当前用户目录 |
| 在显式路径下搜索 | `fnos-cli file search <key> /vol{v}/...` | 每个路径都必须是 规范 路径 |
| 搜别人共享给当前用户的文件 | `fnos-cli file search-others <key>` | 这是 finder 搜索，不是共享目录列表 |
| 列目录、统计路径、查看访问权限 | `file ls-dir/calc/access <path>` | `calc`、`access` 只接受具体 `/vol{v}/...` 路径，`ls-dir` 也可不传路径 |
| 统计卷空间分类 | `fnos-cli file usage <vol>` | `vol` 是存储空间 ID；CLI 汇总全部分段响应 |
| 检查目录内的额外挂载点 | `fnos-cli file is-mount-point <path>` | `hasMount=false` 表示该目录及子目录没有额外挂载点，不表示所在存储卷未挂载 |
| 看文件属性、大小或下载 URL | `file prop/size/download-url <path>` | 只接受具体 `/vol{v}/...` 路径 |
| 看共享目录元数据或列表 | `file share info/list/list-others/admin-list/admin-list-others` | 共享目录与 共享链接 不是同一语义 |
| 看 ACL | `fnos-cli file acl get <path>` | ACL 查询与共享目录状态不是同一概念 |
| 设置 ACL 或所有者 | `file acl set` / `file chown` | 权限写操作，需要 `--yes` |
| 转换或导出 TrimACL 报告 | `file trimacl conv/report` | 权限转换类写操作，需要 `--yes` |
| 做创建、重命名、删除、复制、移动 | `file mkdir/rename/rm/cp/mv` | 写操作默认要求具体 `/vol{v}/...` 路径，并需要 `--yes` |
| 压缩或解压文件 | `file compress/extract` | 写操作，需要 `--yes` |
| 管理当前用户回收站 | `file trash list/search/restore/clear` | 恢复和清空需要 `--yes` |
| 管理收藏夹 | `file fav list/add/del` | `add`、`del` 是写操作，必须显式传 `--yes` |
| 管理团队文件和团队回收站 | `file team list/trash-list-trashbin/trash-list/trash-restore/trash-clear` | `trash-list` 需要团队回收站具体 `path`；无路径时先用 `trash-list-trashbin`；恢复和清空需要 `--yes`，清空需要团队卷号和团队目录名 |
| 上传前检查目标路径 | `fnos-cli file check-upload /vol{v}/... <size> --yes` | 不上传内容，但设备可能创建临时占位 |
| 上传单个本地文件 | `fnos-cli file upload /vol{v}/... <localFile> --yes` | 远端参数是目录，CLI 会拼接本地文件名 |
| 下载一个或多个文件 | `/multiple-download` HTTP 流程 | 当前没有命名 CLI 命令；属于平台文件下载服务，不是 下载中心 CGI |

如果还没判断清楚该走 `ls`、`search`、`search-others` 还是 `share`，先看 `workflows/file-routing.md`。

## 常见误判

- `file ls /` 不是把 `/` 直接传给后端，而是和无参数一样省略 `path`
- “当前用户目录”不是固定写死值，而是由设备返回和 session 信息共同决定
- `file share.*` 说的是共享目录，不是 共享链接
- `file search-others` 找的是“别人共享给我”的文件搜索结果，不是共享目录列表
- `file cp` / `file mv` 的目标参数是目标目录，不是最终文件路径

## 高风险提醒

- 写操作不要使用聚合根、相对路径或模糊路径
- 用户只给了“共享链接”这类表述时，不要直接落到 `file share.*`
- 涉及多路径搜索时，每个路径都要先确认是 `/vol{v}/...`
- 如果需求依赖“当前用户目录”，优先让 CLI 自己探测，不要手工猜 payload

## 端点索引
- 核心列表和元数据：
  - `file.ls`
  - `file.lsDir`
  - `file.calc`
  - `file.prop`
  - `file.access`
  - `file.usage`
- 变更和传输：
  - `file.mkdir`
  - `file.rename`
  - `file.rm`
  - `file.cp`
  - `file.mv`
  - `file.cancel`
- 所有权和 ACL：
  - `file.chown`
  - `file.getAcl`
  - `file.setAcl2`
  - `file.trimacl.conv`
  - `file.trimacl.conv.report`
  - `file.setAcl`（旧 ACL 接口未实现）
- 上传/下载/压缩：
  - `file.checkUpload`
  - `file upload` CLI `/upload` 流程；上传传输跟随当前连接安全策略
  - `/multiple-download` HTTP 流程（当前未实现命名 CLI 命令）
  - `file.download`
  - `file.compress`
  - `file.extract`
  - `file.size`
- 搜索：
  - `appcgi.finder.fileSearch`
  - `appcgi.finder.searchOtherSharing`
  - `appcgi.finder.trashSearch`
  - `appcgi.finder.cancelSearch`
- 共享目录：
  - `file.share.info`
  - `file.share.list`
  - `file.share.listOthers`
  - `file.share.admin.list`
  - `file.share.admin.listOthers`
  - `file.share.add2`
  - `file.share.del2`
- 收藏夹/最近文件：
  - `file.fav.list`、`file.fav.add`、`file.fav.del`
  - `file.recent.list`、`file.recent.add`、`file.recent.del`、`file.recent.clear`
- 应用文件和系统分区：
  - `appcgi.filestor.getAppDirList`
  - `appcgi.filestor.getSysPartInfo`
  - `appcgi.filestor.isMountPoint`
- 回收站：
  - `file.trash.list`、`file.trash.clear`、`file.trash.restore`
- 团队文件：
  - `file.team.lsDir`
  - `file.team.trash.listTrashbin`
  - `file.team.trash.list`
  - `file.team.trash.clear`
  - `file.team.trash.restore`

## 端点详情

### file.ls

#### 端点
`file.ls`

#### 用途
列出后端默认视图或指定 规范 fnOS 路径下的文件。

#### CLI 映射
```
fnos-cli file ls
fnos-cli file ls /
fnos-cli file ls /vol{v}/...
```

路径处理：
- 无参数或 `/` 都归一化为省略 `path` 的模式。
- 非根路径必须为 `/vol{v}/...` 格式，否则 CLI 在发送请求前拒绝。

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束与说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | body | 是 | string | 端点选择标识 | 固定值 `file.ls` | `file.ls` |
| `reqid` | body | 是 | string | 请求关联 ID | 每次请求生成 | `69ba...` |
| `path` | body | 否 | string | 具体目录路径 | 省略时走后端默认视图；指定时必须为 `/vol{v}/...` | `/vol3/1106/test3` |

#### 响应
| 字段 | 始终存在 | 类型 | 含义 | 条件与说明 | 示例 |
| --- | --- | --- | --- | --- | --- |
| `files` | 否 | array | 文件条目块 | 可出现在多个中间包中 | `[{"name":"Photos","dir":1}]` |
| `result` | 否 | string | 终态标记 | `succ`/`fail`；中间包可省略 | `succ` |
| `errno` | 否 | number | 错误码 | `errno: 0` 视为成功 | `65534` |
| `errmsg` | 否 | string | 错误描述 | 失败时出现 | `path not found` |

#### 协议说明
- `file.ls` 可能是多包响应：非终态包携带 `files`，终态包包含 `result`、`errno` 或 `errmsg`。
- 成功判定：`result: succ` 或 `errno: 0`；`result: fail` 或非零 `errno` 为失败。
- 使用签名请求（当 session secret 可用时），格式遵循 `_conventions.md`。

#### 字段语义
- 无参数和 `/` 都会完全省略 `path`，不是设置为 `/`。
- 目标固件如何解释省略 `path` 由设备决定；部分设备会返回当前用户目录，而不是单独的卷列表；请核实实际目标行为。
- `files[].dir` 是目录标记。
- CLI 目前不暴露分页控制，流式消费直到终态包。

#### 错误
- 非法路径格式在发送请求前被拒绝，提示使用 `/vol{v}/...`。
- 后端错误通过 `errmsg`/`errno` 传播。

### file.lsDir

#### 用途
列出文件管理器目录入口或指定目录。该端点可能分多包返回 `files`。

#### CLI 映射
```
fnos-cli file ls-dir
fnos-cli file ls-dir /vol{v}/...
```

#### 协议说明
- CLI 持续接收响应直至终态包，并把所有中间包的 `files` 合并为一个 JSON 数组。
- 终态包通常只包含 `result`、`uver` 等元数据，不会作为目录条目输出。

### file.usage

#### 用途
按分类查询指定存储空间的容量使用情况。

#### CLI 映射
```
fnos-cli file usage <vol>
```

#### 协议说明
- 接口会分多包推送；每个数据包用 `category` 区分 `user`、`team`、`app`、`docker` 等容量分类。
- CLI 输出一个 JSON 数组，不包含没有 `category` 的终态包。
- 同一分类可能重复推送，必须以最后一次为准，不能累加。用户和团队相关分类按 `category + id` 区分，其余分类按 `category` 区分。

### file.fav.add / file.fav.del

```bash
fnos-cli file fav add /vol{v}/... --yes
fnos-cli file fav del /vol{v}/... --yes
```

两者都会修改当前用户收藏夹，必须显式传 `--yes`。缺失时 CLI 会在读取 session 或访问网络前拒绝。

### file.mkdir

#### 端点
`file.mkdir`

#### 用途
在指定 规范 fnOS 路径创建目录。

#### CLI 映射
```
fnos-cli file mkdir /vol{v}/... --yes
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束与说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | body | 是 | string | 端点选择标识 | 固定值 `file.mkdir` | `file.mkdir` |
| `reqid` | body | 是 | string | 请求关联 ID | 每次请求生成 | `69ba...` |
| `path` | body | 是 | string | 目标目录路径 | 必须为 `/vol{v}/...` | `/vol2/1106/new-dir` |

#### 响应
| 字段 | 始终存在 | 类型 | 含义 | 条件与说明 | 示例 |
| --- | --- | --- | --- | --- | --- |
| `result` | 否 | string | 终态标记 | `succ`/`fail` | `succ` |
| `errno` | 否 | number | 错误码 | 失败时出现 | `17` |
| `errmsg` | 否 | string | 错误描述 | | `file exists` |

#### 字段语义
- `path` 是完整目标路径，不是父目录加名称。
- 目前不支持可选的权限参数。

### file.prop

#### 端点
`file.prop`

#### 用途
查看指定文件或目录的属性。

#### CLI 映射
```
fnos-cli file prop /vol{v}/...
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束与说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | body | 是 | string | 端点选择标识 | 固定值 `file.prop` | `file.prop` |
| `reqid` | body | 是 | string | 请求关联 ID | 每次请求生成 | `69ba...` |
| `files` | body | 是 | string[] | 要查询的路径列表 | CLI 当前发送单个路径 | `["/vol2/1106/a.txt"]` |

### file.size

#### 端点
`file.size`

#### 用途
查看单个文件或目录的大小。

#### CLI 映射
```
fnos-cli file size /vol{v}/...
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束与说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | body | 是 | string | 端点选择标识 | 固定值 `file.size` | `file.size` |
| `reqid` | body | 是 | string | 请求关联 ID | 每次请求生成 | `69ba...` |
| `file` | body | 是 | string | 要计算的路径 | 单个 规范 路径 | `/vol2/1106/a.txt` |

### file.download

#### 端点
`file.download`

#### 用途
请求一个或多个文件的下载 URL。

#### CLI 映射
```
fnos-cli file download-url /vol{v}/...
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束与说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | body | 是 | string | 端点选择标识 | 固定值 `file.download` | `file.download` |
| `reqid` | body | 是 | string | 请求关联 ID | 每次请求生成 | `69ba...` |
| `files` | body | 是 | string[] | 要下载的路径列表 | CLI 当前发送单个路径 | `["/vol2/1106/a.txt"]` |

### file.rename

#### 端点
`file.rename`

#### 用途
重命名指定文件或目录。

#### CLI 映射
```
fnos-cli file rename /vol{v}/... <newName> --yes
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束与说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | body | 是 | string | 端点选择标识 | 固定值 `file.rename` | `file.rename` |
| `reqid` | body | 是 | string | 请求关联 ID | 每次请求生成 | `69ba...` |
| `path` | body | 是 | string | 要重命名的路径 | 必须为 `/vol{v}/...` | `/vol2/1106/a.txt` |
| `newName` | body | 是 | string | 新名称 | 只能是名称片段，不能包含 `/` | `b.txt` |

### file.checkUpload

#### 端点
`file.checkUpload`

#### 用途
上传文件前检查完整目标文件路径是否可用，并返回同名冲突、断点续传或最终文件名等提示。

#### CLI 映射
```
fnos-cli file check-upload /vol{v}/... <size> [--overwrite skip|replace|rename] --yes
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束与说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | body | 是 | string | 端点选择标识 | 固定值 `file.checkUpload` | `file.checkUpload` |
| `reqid` | body | 是 | string | 请求关联 ID | 每次请求生成 | `69ba...` |
| `path` | body | 是 | string | 完整目标文件路径 | 必须包含文件名，且为 `/vol{v}/...` | `/vol2/1106/new.jpg` |
| `size` | body | 是 | number | 文件大小 | 字节数 | `12345` |
| `overwrite` | body | 否 | number | 同名冲突处理 | `0` 跳过、`1` 替换、`2` 重命名 | `2` |

#### 响应
| 字段 | 始终存在 | 类型 | 含义 | 条件与说明 | 示例 |
| --- | --- | --- | --- | --- | --- |
| `result` | 否 | string | 终态标记 | `succ`/`fail` | `succ` |
| `skip` | 否 | number | 跳过提示 | 部分版本返回 | `1` |
| `uploadName` | 否 | string | HTTP 上传/断点路径文件名 | POST `/upload` 的 `Trim-Path` 使用该名称；它不一定等于用户最终看到的文件名 | `new.iso.~#2` |
| `from` | 否 | number | 续传起点 | 部分版本返回 | `1048576` |
| `completed` | 否 | number | 已完成字节数 | 部分版本返回 | `1048576` |
| `errno` | 否 | number | 错误码 | 失败时出现 | `4386` |
| `errmsg` | 否 | string | 错误描述 | | `no space left` |

#### 字段语义
- `path` 是完整目标文件路径，不是目标目录。
- `file check-upload` 不传输文件内容，但后端可能分配 `.~#n` 临时上传占位，因此仍属于写操作。
- `--overwrite` 支持 `skip`、`replace`、`rename`，也可传对应数值 `0`、`1`、`2`。

### file upload CLI 流程

#### 用途
上传单个本地文件到远端目录。

#### CLI 映射
```
fnos-cli file upload /vol{v}/... <localFile> [--overwrite skip|replace|rename] --yes
```

#### 流程
1. 远端目录规范化为 `/vol{v}/...`。
2. 使用本地文件名拼出完整远端目标路径。
3. 调用 `file.checkUpload`。
4. `skip` 或 `completed` 为非零数值时无需发送 HTTP 上传；字段缺失或为零不会跳过传输。
5. 如果返回 `uploadName`，HTTP `Trim-Path` 使用父目录加该名称；用户可见结果仍是请求的目标路径。
6. 通过 `POST /ogh/ac/h/upload` 上传 multipart 字段 `trim-upload-file`。传输遵循当前 HTTP/HTTPS 连接与 TLS 策略：回环默认 HTTP，远端默认 HTTPS；远端明文 HTTP 需显式允许。
7. 20 MiB 及以上文件会缓存 `uploadName` 路径用于后续断点续传；缓存按 NAS endpoint、profile、登录用户、远端目标、文件大小、覆盖策略和本地文件 SHA-256 隔离，只有完整匹配时才会续传。同一 NAS endpoint 和远端目标的上传会跨进程串行执行。缓存续传遇到 `328496` 会重试，遇到 `4100` 会回退普通检查。

#### HTTP 请求头
| 请求头 | 必填 | 含义 |
| --- | --- | --- |
| `Trim-Path` | 是 | 经过 URI 编码的 HTTP 上传路径；可能使用后端 `uploadName` |
| `Trim-From` | 是 | 续传起点；无续传时为 `0` |
| `Trim-Overwrite` | 是 | `0` 跳过、`1` 替换、`2` 重命名 |
| `Trim-Mtim` | 是 | 本地文件 mtime，Unix 秒 |
| `Authorization` | 是 | 代理客户端附加 OAuth `Bearer` 认证；不要暴露 token |
| `Trim-Token` | 否 | 旧直连字段，当前 HTTP 代理不发送 |
| `Trim-Sign` | 否 | 旧直连签名，当前 HTTP 代理不发送 |

### multiple-download HTTP 流程

#### 端点

```plaintext
POST /multiple-download
GET  /multiple-download?token=<download-token>
```

#### 用途

为一个或多个 fnOS 文件/目录创建临时下载链接；单文件可直接下载，多目标通常由平台打包后下载。

#### 请求

| 字段 | 位置 | 必填 | 类型 | 含义 | 示例 |
| --- | --- | --- | --- | --- | --- |
| `accessToken` | POST body | 是 | string | 当前 OAuth access token | `<access-token>` |
| `paths` | POST body | 是 | string[] | 下载目标路径 | `["/vol1/1000/a.txt"]` |
| `downloadLimit` | POST body | 否 | number | 当前前端使用的下载/打包限制 | `2` |
| `noZipWhenSingleFile` | POST body | 否 | boolean | 单文件不打 zip | `true` |
| `zipFileName` | POST body | 否 | string | 下载或压缩包名称 | `a.txt等2个文件` |
| `token` | GET query | 是 | string | POST 返回的临时下载 token | `<download-token>` |

#### 流程

1. 携带 Bearer，并向 `/ogh/ac/h/multiple-download` POST `accessToken` 和 `paths`；成功响应读取临时 `token`。
2. 携带 Bearer 打开 `GET /ogh/ac/h/multiple-download?token=<download-token>` 获取文件或压缩包字节流。
3. 可使用 `Range` 请求分段下载，成功时返回 HTTP 206；只有临时 token 而没有 Bearer 时会返回 401。
4. HTTP 403 时，响应 body 表示首个无权限路径。

#### CLI 支持范围

- 当前 Rust CLI 未实现对应命名命令，也不能通过 `download request` 调用，因为它不是 `appcgi.downloadcenter.*` CGI。
- GET 临时链接仍要求 Bearer，不可当作匿名、免鉴权分享链接。
- access token 和临时下载 token 都属于敏感凭据，不应记录或转发。

### file.rm

#### 端点
`file.rm`

#### 用途
删除指定 规范 fnOS 路径的文件或目录。

#### CLI 映射
```
fnos-cli file rm /vol{v}/... --yes
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束与说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | body | 是 | string | 端点选择标识 | 固定值 `file.rm` | `file.rm` |
| `reqid` | body | 是 | string | 请求关联 ID | 每次请求生成 | `69ba...` |
| `files` | body | 是 | string[] | 要删除的路径列表 | CLI 当前发送单个路径 | `["/vol2/1106/old-dir"]` |

#### 字段语义
- 后端使用 `files: string[]`，不是单个 `path` 字段。
- CLI 当前只暴露单目标删除，但后端支持数组。

### file.trash.list

#### 端点
`file.trash.list`

#### 用途
列出当前用户回收站文件。

#### CLI 映射
```
fnos-cli file trash list
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束与说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | body | 是 | string | 端点选择标识 | 固定值 `file.trash.list` | `file.trash.list` |
| `reqid` | body | 是 | string | 请求关联 ID | 每次请求生成 | `69ba...` |

### file.trash.restore

#### 端点
`file.trash.restore`

#### 用途
从回收站恢复指定文件。

#### CLI 映射
```
fnos-cli file trash restore /vol{v}/... --yes
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束与说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | body | 是 | string | 端点选择标识 | 固定值 `file.trash.restore` | `file.trash.restore` |
| `reqid` | body | 是 | string | 请求关联 ID | 每次请求生成 | `69ba...` |
| `files` | body | 是 | string[] | 要恢复的回收站路径 | CLI 当前发送单个路径 | `["/vol2/1106/a.txt"]` |
| `overwrite` | body | 是 | number | 冲突处理策略 | `2` 表示自动改名保留两者 | `2` |

### file.trash.clear

#### 端点
`file.trash.clear`

#### 用途
清空当前用户回收站。

#### CLI 映射
```
fnos-cli file trash clear --yes
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束与说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | body | 是 | string | 端点选择标识 | 固定值 `file.trash.clear` | `file.trash.clear` |
| `reqid` | body | 是 | string | 请求关联 ID | 每次请求生成 | `69ba...` |

### file.cp

#### 端点
`file.cp`

#### 用途
将文件或目录复制到指定 规范 fnOS 目标目录。

#### CLI 映射
```
fnos-cli file cp <src> <destDir> --yes
```

`src` 和 `destDir` 必须都是 `/vol{v}/...` 格式。

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束与说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | body | 是 | string | 端点选择标识 | 固定值 `file.cp` | `file.cp` |
| `reqid` | body | 是 | string | 请求关联 ID | 每次请求生成 | `69ba...` |
| `files` | body | 是 | string[] | 源路径列表 | CLI 当前发送单个源路径 | `["/vol3/1106/source"]` |
| `pathTo` | body | 是 | string | 目标目录路径 | 必须为 `/vol{v}/...` | `/vol4/1106/backup` |
| `overwrite` | body | 是 | number | 冲突策略 | CLI 默认 `2`（保留两者/重命名） | `2` |

#### 字段语义
- 后端使用 `files + pathTo`，不是 `src + dest`。
- `overwrite: 2` 当前作为保留两者/重命名策略。
- CLI 当前只暴露单源复制，但后端支持数组。

### file.mv

#### 端点
`file.mv`

#### 用途
将文件或目录移动到指定 规范 fnOS 目标目录。

#### CLI 映射
```
fnos-cli file mv <src> <destDir> --yes
```

`src` 和 `destDir` 必须都是 `/vol{v}/...` 格式。

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束与说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | body | 是 | string | 端点选择标识 | 固定值 `file.mv` | `file.mv` |
| `reqid` | body | 是 | string | 请求关联 ID | 每次请求生成 | `69ba...` |
| `files` | body | 是 | string[] | 源路径列表 | CLI 当前发送单个源路径 | `["/vol4/1106/source"]` |
| `pathTo` | body | 是 | string | 目标目录路径 | 必须为 `/vol{v}/...` | `/vol2/1106/archive` |
| `overwrite` | body | 是 | number | 冲突策略 | CLI 默认 `2`（保留两者/重命名） | `2` |

#### 字段语义
- 与 `file.cp` 相同的请求结构和冲突策略。

### appcgi.finder.fileSearch

#### 端点
`appcgi.finder.fileSearch`

#### 用途
使用 finder 服务在一个或多个 规范 fnOS 路径下按关键字搜索文件。

#### CLI 映射
```
fnos-cli file search <key> [paths...]
```

路径处理：
- 每个显式路径必须为 `/vol{v}/...` 格式，传给 finder 时去除前导斜杠。
- 未提供路径时，CLI 先做一次省略 `path` 的 `file.ls` 探测，再从返回条目的 `v` 字段推导当前用户的 `vol{v}/{uid}` 搜索根。
- 当 session 中包含 `uid` 时会在请求中包含。

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束与说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | body | 是 | string | 端点选择标识 | 固定值 | `appcgi.finder.fileSearch` |
| `reqid` | body | 是 | string | 请求关联 ID | 每次请求生成 | `69be...` |
| `key` | body | 是 | string | 搜索关键字 | 不能为空 | `.txt` |
| `path` | body | 是 | string[] | finder 搜索根 | 使用 `vol{v}/...` 格式（无前导斜杠） | `["vol2/1000"]` |
| `uid` | body | 否 | number | 当前用户 ID | 从 session 获取时包含 | `1000` |

#### 响应
| 字段 | 始终存在 | 类型 | 含义 | 条件与说明 | 示例 |
| --- | --- | --- | --- | --- | --- |
| `data` | 否 | array | 搜索结果块 | 流式包将结果放在顶层 `data` 中 | `[{"path":"/vol2/1000/a.txt"}]` |
| `result` | 否 | string | finder 状态 | `doing` 处理中；`succ` 完成；`fail` 失败 | `doing` |
| `errno` | 否 | number | 错误码 | 可终止请求 | `100000002` |
| `errmsg` | 否 | string | 错误描述 | | `param invalid` |

#### 协议说明
- Finder 搜索是多包响应。中间包可同时携带 `data` 和 `result: doing`。
- `result: doing` 不是终态。CLI 等待后续包中的非 `doing` 状态。

### appcgi.finder.searchOtherSharing

#### 端点
`appcgi.finder.searchOtherSharing`

#### 用途
搜索其他用户共享给当前用户的文件。

#### CLI 映射
```
fnos-cli file search-others <key>
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束与说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | body | 是 | string | 端点选择标识 | 固定值 | `appcgi.finder.searchOtherSharing` |
| `reqid` | body | 是 | string | 请求关联 ID | 每次请求生成 | `69be...` |
| `key` | body | 是 | string | 搜索关键字 | | `.txt` |

#### 协议说明
- 与 `fileSearch` 相同的 finder 终态语义。
- 中间包 `result: doing` 为非终态。
- 流式结果字段为 `files`。

### file.getAcl

#### 端点
`file.getAcl`

#### 用途
返回指定 规范 fnOS 路径的 ACL 信息，可选包含文件属性数据。

#### CLI 映射
```
fnos-cli file acl get <path>
fnos-cli file acl get <path> --prop
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束与说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | body | 是 | string | 端点选择标识 | 固定值 `file.getAcl` | `file.getAcl` |
| `reqid` | body | 是 | string | 请求关联 ID | 每次请求生成 | `69be...` |
| `path` | body | 是 | string | 目标路径 | 必须为 `/vol{v}/...` | `/vol1/1000/docs` |
| `getProp` | body | 否 | boolean | 是否包含属性数据 | `--prop` 时发送 `true` | `true` |

#### 字段语义
- `permset` 是最有用的原始 ACL/共享权限数据，CLI 原样保留。
- `getProp` 为透传标志。

### file.share.info

#### 端点
`file.share.info`

#### 用途
返回指定 规范 fnOS 路径的共享目录元数据。

#### CLI 映射
```
fnos-cli file share info <path>
```

### file.share.list / file.share.admin.list

#### 端点
`file.share.list` 和 `file.share.admin.list`

#### 用途
列出共享目录。`list` 使用当前用户视角；`admin-list` 使用管理员视角。

#### CLI 映射
```
fnos-cli file share list [uid]
fnos-cli file share admin-list [uid]
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束与说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | body | 是 | string | 端点选择标识 | `file.share.list` 或 `file.share.admin.list` | `file.share.list` |
| `reqid` | body | 是 | string | 请求关联 ID | 每次请求生成 | `69be...` |
| `uid` | body | 否 | number | 源用户/owner ID 过滤 | 必须为正整数 | `1001` |

#### 协议说明
- 两个端点都是多包列表流。中间包贡献 `share[]`。

### file.share.listOthers / file.share.admin.listOthers

#### 端点
`file.share.listOthers` 和 `file.share.admin.listOthers`

#### 用途
列出哪些用户拥有可见的共享目录。

#### CLI 映射
```
fnos-cli file share list-others
fnos-cli file share admin-list-others
```

### file.share.add2

#### 端点
`file.share.add2`

#### 用途
将指定路径创建为共享目录，使用显式的 `permset` 权限。

#### CLI 映射
```
fnos-cli file share add <path> <shareName> --permset <json> [--sub] [--acl-mode <mode>] --yes
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束与说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | body | 是 | string | 端点选择标识 | 固定值 `file.share.add2` | `file.share.add2` |
| `reqid` | body | 是 | string | 请求关联 ID | 每次请求生成 | `69be...` |
| `path` | body | 是 | string | 目标路径 | 必须为 `/vol{v}/...` | `/vol1/1000/docs` |
| `shareName` | body | 是 | string | 共享目录显示名 | | `docs` |
| `permset` | body | 是 | array | ACL/共享权限 | 必须为 JSON 对象数组 | `[{"owner":32719,"inherit":7}]` |
| `sub` | body | 否 | boolean | 是否应用到子项 | `--sub` 时发送 | `true` |
| `aclMode` | body | 否 | number | 显式 ACL 模式 | `--acl-mode` 时发送 | `1` |

#### 字段语义
- `permset` 原样转发，可直接复用 `file acl get` 返回的原始数据。

### file.share.del2

#### 端点
`file.share.del2`

#### 用途
移除指定路径的共享目录状态。

#### CLI 映射
```
fnos-cli file share del <path> [--sub] [--acl-mode <mode>] --yes
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束与说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | body | 是 | string | 端点选择标识 | 固定值 `file.share.del2` | `file.share.del2` |
| `reqid` | body | 是 | string | 请求关联 ID | 每次请求生成 | `69be...` |
| `path` | body | 是 | string | 目标路径 | 必须为 `/vol{v}/...` | `/vol1/1000/docs` |
| `sub` | body | 否 | boolean | 是否应用到子项 | `--sub` 时发送 | `true` |
| `aclMode` | body | 否 | number | 显式 ACL 模式 | `--acl-mode` 时发送 | `1` |

## 注意事项
- 长时间运行的文件操作（如大文件复制/移动）的包终态行为可能因固件版本而异。
- ACL 和跨卷传输的完整错误码分类尚未完全确认。
- `overwrite: 2` 的具体冲突处理行为（保留两者/重命名）取决于后端实现。
