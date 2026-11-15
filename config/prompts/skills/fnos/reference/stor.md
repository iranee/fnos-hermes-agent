# stor 模块

## 模块概述
存储管理模块，涵盖存储池、磁盘、SMART 操作、挂载/弹出流程、容量/空间报告和用户存储分配。

## 模块约定
- 区分可能唤醒磁盘的操作和不唤醒磁盘的操作。
- 破坏性操作和预检端点在错误说明和协议说明中明确标注。
- 存储池目标请求使用 `uuid`，不再使用旧版 `name`。

## 高风险密码验证策略
fnos-cli 使用 `appcgi.usersrv.authUser` 作为高风险存储写操作的预检密码验证。

| 策略 | 命令 |
| --- | --- |
| 验证 + 转发密码 | `storage umount`、`storage create`、`storage stop`、`storage add-disk`、`storage remove-disk`、`storage replace-disk`、`storage resize` |
| 仅验证，不转发密码 | `storage extend`、`storage format`、`storage eject` |
| 仅确认，无密码验证 | `storage mount`、`storage disk-mount`、`storage disk-umount` |
| 通用请求 | `storage request` 默认确认；传 `--password` 时先验证再转发 |

## 任务路由

先按“读”还是“改”区分：

| 用户意图 | 优先命令 | 说明 |
| --- | --- | --- |
| 看存储总览 | `fnos-cli storage overview` | 适合作为只读探测入口 |
| 列存储池 | `fnos-cli storage pools` | 用来确认 pool uuid 或 `trim_*` 标识 |
| 列磁盘 | `fnos-cli storage disks` | 用来确认纯设备名 |
| 看 SMART / 健康 | `fnos-cli storage smart <disk>` / `health <disk>` | 先确认目标是磁盘，不是存储池 |
| 看可移动设备 | `fnos-cli storage removable` / `disk-info <disk>` | `format` / `eject` / `disk-mount` / `disk-umount` 前优先看 |
| 做高风险写操作 | 先看 `workflows/storage-dangerous-ops.md` | 先做只读探测，再决定是否继续 |
| 调用未封装端点 | `fnos-cli storage request stor.<name> --json '<object>'` | 优先用固定命令；仅对缺失的 `stor.*` 端点使用 |

## 常见误判

- `mount` 不是 `stop` 的逆操作；先确认目标池当前状态
- `extend` 和 `resize` 不是同义词
- `format` / `eject` 面向可移动设备，不是普通池管理命令
- 池操作使用 uuid 或 `trim_*`，磁盘操作使用纯设备名
- `storage create` / `resize` 的 `--level` 只能用 `0`、`1`、`4`、`5`、`6`、`10`

## 高风险提醒

- 任何写操作前都应先执行 `storage pools` 和 `storage disks`
- 创建存储池前应额外执行 `storage free-disks`，以确认可创建候选项；系统盘剩余空间候选要用返回的 `part` 创建，不要用整盘 `name`
- 需要密码验证的命令在缺密码时不要继续猜测
- 只读探测结果与用户描述不一致时，应先停下来确认目标
- `format`、`stop`、`remove-disk`、`replace-disk` 这类操作影响面较大，不应跨多个目标一次性执行
- `storage request` 是受控后备入口，不应用来绕过固定命令的校验和工作流

## 端点索引
- 池和磁盘发现（已实现）：
  - `stor.listStor` — 列出存储池
  - `stor.listDisk` — 列出磁盘
  - `stor.listFreeDisk` — 列出可创建存储池的候选磁盘/分区
  - `stor.general` — 存储总览
  - `stor.calcSpace` — 聚合空间
  - `stor.listRemovable` — 可移动设备
  - `stor.diskInfo` — 指定磁盘详情
- 池生命周期（已实现）：
  - `stor.create` — 创建存储池
  - `stor.mount` — 挂载存储池
  - `stor.umount` — 卸载存储池
  - `stor.stop` — 停止/删除存储池
- 扩展和磁盘管理（已实现）：
  - `stor.addDisk` — 添加磁盘
  - `stor.removeDisk` — 移除磁盘
  - `stor.replaceDisk` — 替换磁盘
  - `stor.extend` — 扩展存储池
  - `stor.resize` — 调整存储池
- SMART 和健康（已实现）：
  - `stor.diskHealth` — 磁盘健康
  - `stor.diskSmart` — SMART 信息
- 可移动设备（已实现）：
  - `stor.diskMount` — 挂载可移动磁盘
  - `stor.diskUmount` — 卸载可移动磁盘
  - `stor.format` — 格式化
  - `stor.eject` — 弹出
- 通用请求（已实现）：
  - `stor.*` — 通过 `storage request` 调用尚未封装为固定命令的存储端点
- 未实现：
  - `stor.state` / `stor.state2`、`stor.getSysPartInfo`
  - `stor.delRec`、`stor.lvActive`
  - `stor.readdDisk`、`stor.removeDiskCheck`、`stor.addSpareDisk`
  - `stor.enableSmart`、`stor.runSmartTest`、`stor.abortSmartTest`
  - 固定配置命令：`stor.getConf`、`stor.setConf`、`stor.removeWarn`、`stor.setTrashbin` 等
  - 用户存储：`stor.getUserStorage`、`stor.setUserStorage`

## 端点详情

### stor.general

#### 端点
`stor.general`

#### 用途
获取存储总览信息。

#### CLI 映射
```
fnos-cli storage overview
```

#### 协议说明
- 旧版端点名 `stor.getStorGeneral` 已弃用。

### stor.listStor

#### 端点
`stor.listStor`

#### 用途
列出存储池及相关磁盘元数据。

#### CLI 映射
```
fnos-cli storage pools
```

#### 协议说明
- 可能是多阶段响应：先返回基础池列表，后续跟进已移除磁盘/热备/缓存详情。
- 在线管理员可能收到 `{"sysNotify":"storageChanged"}` 通知，此时应刷新输出。

#### 字段语义
- `degraded`、`fixNeedDisks` 已在部分固件的存储池响应中出现，但字段精确语义和跨固件一致性尚未确认，不能仅凭非零值断言磁盘故障、必须修复或数据风险等级。
- SMART、`md[].arrayState`、`md[].syncAction` 可作为相邻证据，但现有资料不足以确定它们与上述字段的组合关系；应保留原始值并在 fnOS 存储页核对。
- CLI 只透传这些字段，不会自动解释或执行修复。

### stor.listDisk

#### 端点
`stor.listDisk`

#### 用途
列出存储服务已知的磁盘。

#### CLI 映射
```
fnos-cli storage disks
```

#### 协议说明
- 该端点可能先返回磁盘数据帧，再返回成功终态；CLI 会收集所有帧中的 `disk` 数组，并按 `name` 合并重复磁盘。
- 如果所有帧均不含磁盘数据，输出包含空的 `disk` 数组。

#### 字段语义
- 返回的磁盘标识是 `stor.diskHealth`、`stor.diskSmart`、`stor.format` 和 `stor.eject` 使用的规范磁盘名。

### stor.diskInfo

#### 端点
`stor.diskInfo`

#### 用途
查询指定磁盘的详细信息，常用于可移动磁盘分区、容量和文件系统确认。

#### CLI 映射
```
fnos-cli storage disk-info <disk>
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | 请求体 | 是 | 字符串 | 端点选择器 | 固定值 `stor.diskInfo` | `stor.diskInfo` |
| `reqid` | 请求体 | 是 | 字符串 | 请求关联 ID | 每次请求生成 | `69ba...` |
| `disk` | 请求体 | 是 | 字符串 | 磁盘设备名 | 纯设备名如 `sdc`、`nvme0n1` | `sdc` |

### stor.diskMount / stor.diskUmount

#### 端点
`stor.diskMount` 和 `stor.diskUmount`

#### 用途
挂载或卸载指定可移动磁盘。

#### CLI 映射
```
fnos-cli storage disk-mount <disk> [--yes]
fnos-cli storage disk-umount <disk> [--yes]
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | 请求体 | 是 | 字符串 | 端点选择器 | `stor.diskMount` 或 `stor.diskUmount` | `stor.diskMount` |
| `reqid` | 请求体 | 是 | 字符串 | 请求关联 ID | 每次请求生成 | `69ba...` |
| `disk` | 请求体 | 是 | 字符串 | 可移动磁盘设备名 | 应来自 `storage removable` / `storage disk-info` 确认 | `sdc` |

#### 协议说明
- 默认需要交互确认；`--yes` 可跳过确认。
- 不做密码验证。

### stor.listFreeDisk

#### 端点
`stor.listFreeDisk`

#### 用途
列出可用于创建存储池的候选磁盘或分区。

#### CLI 映射
```
fnos-cli storage free-disks
```

#### 协议说明
- 这个端点用于创建前候选判断，和 `storage disks` 的通用磁盘清单语义不同。
- 普通数据盘候选通常直接用 `name` 创建。
- 系统盘剩余空间可用时，返回项通常带 `sys: 1`、`part`、`partSize`；创建时 `--disks` 应传 `part`，容量按 `partSize` 判断。

#### 字段语义
- 返回顶层通常包含 `disk` 数组。
- `name` 是整盘设备名。
- `part` 是可用于创建存储池的分区名，仅在系统盘剩余空间等场景出现。
- `partSize` 是可创建分区容量。

### stor.calcSpace

#### 端点
`stor.calcSpace`

#### 用途
报告聚合的系统分区和存储分区空间使用情况。

#### CLI 映射
```
fnos-cli storage space
```

### stor.listRemovable

#### 端点
`stor.listRemovable`

#### 用途
列出已挂载的可移动存储设备。

#### CLI 映射
```
fnos-cli storage removable
```

### stor.diskHealth / stor.diskSmart

#### 端点
`stor.diskHealth` 和 `stor.diskSmart`

#### 用途
查询指定磁盘的健康指标和 SMART 详情。

#### CLI 映射
```
fnos-cli storage health <disk>
fnos-cli storage smart <disk>
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | 请求体 | 是 | 字符串 | 端点选择器 | `stor.diskHealth` 或 `stor.diskSmart` | `stor.diskHealth` |
| `reqid` | 请求体 | 是 | 字符串 | 请求关联 ID | 每次请求生成 | `69ba...` |
| `disks` | 请求体 | 是 | 字符串数组 | `stor.diskHealth` 的磁盘设备名列表 | CLI 单盘命令会发送为单元素数组 | `["nvme0n1"]` |
| `disk` | 请求体 | 是 | 字符串 | `stor.diskSmart` 的磁盘设备名 | CLI 发送纯设备名 | `nvme0n1` |
| `wakeup` | 请求体 | 否 | 布尔值 | 查询前唤醒磁盘 | `diskHealth` 发送 `true`；`diskSmart` 使用设备默认值 | `true` |

#### 协议说明
- `stor.diskSmart` 在磁盘休眠时可能返回 `diskStandby` 标记而非完整 SMART 数据。
- `listDisk` 会聚合终态前的数据帧；列表确实为空时输出 `disk: []`。`listFreeDisk` 成功但无候选项时补 `disk: []`，`listRemovable` 成功但无设备时补 `removable: []`。
- `diskHealth` 使用 `disks` 数组；`diskSmart` 仍使用单数 `disk`。

### stor.create

#### 端点
`stor.create`

#### 用途
从指定 RAID/存储级别和磁盘集创建新存储池。

#### CLI 映射
```
fnos-cli storage create --level <level> --disks <disk> [--disks <disk>...] [--comment <comment>] [--fstype <fstype>] [--check-disk] [--password <password>] [--yes]
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | 请求体 | 是 | 字符串 | 端点选择器 | 固定值 `stor.create` | `stor.create` |
| `reqid` | 请求体 | 是 | 字符串 | 请求关联 ID | 每次请求生成 | `69ba...` |
| `level` | 请求体 | 是 | 数值 | RAID/存储级别 | 允许 `0`、`1`、`4`、`5`、`6`、`10`；`0` 是 RAID 0，至少需要 2 块盘 | `1` |
| `disks` | 请求体 | 是 | 字符串数组 | 磁盘设备名列表 | 支持重复 `--disks` 或逗号分隔，去重，并按 level 校验数量 | `["sdb","sdc"]` |
| `comment` | 请求体 | 否 | 字符串 | 池注释 | 可选 | `pool-a` |
| `fstype` | 请求体 | 否 | 字符串 | 文件系统类型 | 小写标识如 `ext4` | `ext4` |
| `checkDisk` | 请求体 | 否 | 布尔值 | 磁盘预检 | `--check-disk` 时发送 | `true` |
| `password` | 请求体 | 否 | 字符串 | 密码 | 预检验证后转发 | |

#### 字段语义
- `level` 为数值型，与后端请求契约保持一致。
- `disks` 必须是纯设备名，不接受 `/dev/sdb` 形式。
- 创建前会先做本地磁盘数量校验：`0` 至少 2 块，`5` 至少 3 块，`6` 和 `10` 至少 4 块，`10` 还要求偶数块。

### stor.mount / stor.umount

#### 端点
`stor.mount` 和 `stor.umount`

#### 用途
挂载或卸载存储池。

#### CLI 映射
```
fnos-cli storage mount <uuid> [-y]
fnos-cli storage umount <uuid> [--password <password>] [-y]
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | 请求体 | 是 | 字符串 | 端点选择器 | `stor.mount` 或 `stor.umount` | `stor.mount` |
| `reqid` | 请求体 | 是 | 字符串 | 请求关联 ID | 每次请求生成 | `69ba...` |
| `uuid` | 请求体 | 是 | 字符串 | 存储池 uuid | 不使用旧版 `name` | `trim_pool` |
| `password` | 请求体 | 视条件 | 字符串 | 密码 | 仅 `umount` 时需要 | |

#### 协议说明
- `storage mount` 仅确认，不做密码验证。
- `storage umount` 先验密后转发密码。
- `stor.mount` 不是 `stor.stop` 的通用撤销操作。

### stor.stop

#### 端点
`stor.stop`

#### 用途
停止并删除存储池。

#### CLI 映射
```
fnos-cli storage stop <uuid> [--password <password>] [-y]
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | 请求体 | 是 | 字符串 | 端点选择器 | 固定值 `stor.stop` | `stor.stop` |
| `reqid` | 请求体 | 是 | 字符串 | 请求关联 ID | 每次请求生成 | `69ba...` |
| `uuid` | 请求体 | 是 | 字符串 | 存储池 uuid | | `trim_pool` |
| `password` | 请求体 | 否 | 字符串 | 密码 | 预检验证后转发 | |

#### 字段语义
- `stor.stop` 是主要的"删除存储空间"操作，适用于普通池、非活跃池和缓存损坏池。

### stor.addDisk

#### 端点
`stor.addDisk`

#### 用途
向存储池添加磁盘。

#### CLI 映射
```
fnos-cli storage add-disk <uuid> --disks <disk> [--disks <disk>...] [--password <password>] [-y]
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | 请求体 | 是 | 字符串 | 端点选择器 | 固定值 `stor.addDisk` | `stor.addDisk` |
| `reqid` | 请求体 | 是 | 字符串 | 请求关联 ID | 每次请求生成 | `69ba...` |
| `uuid` | 请求体 | 是 | 字符串 | 存储池 uuid | | `trim_pool` |
| `disks` | 请求体 | 是 | 字符串数组 | 要添加的磁盘 | 支持重复或逗号分隔 | `["sdd"]` |
| `password` | 请求体 | 否 | 字符串 | 密码 | 预检验证后转发 | |

### stor.removeDisk

#### 端点
`stor.removeDisk`

#### 用途
从存储池移除磁盘。

#### CLI 映射
```
fnos-cli storage remove-disk <uuid> --disks <disk> [--password <password>] [-y]
```

### stor.replaceDisk

#### 端点
`stor.replaceDisk`

#### 用途
替换存储池中的磁盘。

#### CLI 映射
```
fnos-cli storage replace-disk <uuid> --disks <disk> --new-disks <disk> [--password <password>] [-y]
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | 请求体 | 是 | 字符串 | 端点选择器 | 固定值 `stor.replaceDisk` | `stor.replaceDisk` |
| `reqid` | 请求体 | 是 | 字符串 | 请求关联 ID | 每次请求生成 | `69ba...` |
| `uuid` | 请求体 | 是 | 字符串 | 存储池 uuid | | `trim_pool` |
| `disks` | 请求体 | 是 | 字符串数组 | 要替换的旧磁盘 | | `["sdb"]` |
| `newDisks` | 请求体 | 是 | 字符串数组 | 替换用的新磁盘 | 必须与 `disks` 等长 | `["sdg"]` |
| `password` | 请求体 | 是 | 字符串 | 密码 | 预检验证后转发 | |

#### 字段语义
- `disks[i]` 和 `newDisks[i]` 形成替换对。

### stor.extend

#### 端点
`stor.extend`

#### 用途
触发存储池扩展流程。

#### CLI 映射
```
fnos-cli storage extend <uuid> [--password <password>] [-y]
```

#### 协议说明
- 仅验密，不转发密码；目标请求只包含 `uuid`。

### stor.resize

#### 端点
`stor.resize`

#### 用途
调整存储池大小或重塑存储池布局。

#### CLI 映射
```
fnos-cli storage resize <uuid> --disks <disk> [--vd-name <name>] [--level <level>] [--password <password>] [-y]
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | 请求体 | 是 | 字符串 | 端点选择器 | 固定值 `stor.resize` | `stor.resize` |
| `reqid` | 请求体 | 是 | 字符串 | 请求关联 ID | 每次请求生成 | `69ba...` |
| `uuid` | 请求体 | 是 | 字符串 | 存储池 uuid | | `trim_pool` |
| `disks` | 请求体 | 是 | 字符串数组 | 参与调整的磁盘 | | `["sdh"]` |
| `vdName` | 请求体 | 否 | 字符串 | 目标虚拟设备名 | 可选 | `raidz1-0` |
| `level` | 请求体 | 否 | 数值 | 目标 RAID 级别 | 允许 `0`、`1`、`4`、`5`、`6`、`10` | `5` |
| `password` | 请求体 | 否 | 字符串 | 密码 | 预检验证后转发 | |

### stor.format

#### 端点
`stor.format`

#### 用途
格式化可移动磁盘或分区。

#### CLI 映射
```
fnos-cli storage format <disk> --fstype <fstype> [--partition <no>] [--password <password>] [-y]
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | 请求体 | 是 | 字符串 | 端点选择器 | 固定值 `stor.format` | `stor.format` |
| `reqid` | 请求体 | 是 | 字符串 | 请求关联 ID | 每次请求生成 | `69ba...` |
| `disk` | 请求体 | 是 | 字符串 | 磁盘设备名 | 纯设备名 | `sdb` |
| `no` | 请求体 | 是 | 数值 | 分区号 | `0` 表示整盘 | `0` |
| `fstype` | 请求体 | 是 | 字符串 | 文件系统类型 | 小写 | `ext4` |

### stor.eject

#### 端点
`stor.eject`

#### 用途
安全弹出可移动磁盘。

#### CLI 映射
```
fnos-cli storage eject <disk> [--password <password>] [-y]
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | 请求体 | 是 | 字符串 | 端点选择器 | 固定值 `stor.eject` | `stor.eject` |
| `reqid` | 请求体 | 是 | 字符串 | 请求关联 ID | 每次请求生成 | `69ba...` |
| `disk` | 请求体 | 是 | 字符串 | 可移动磁盘设备名 | 应来自 `stor.listRemovable` 返回的标识 | `sdc` |

### stor.* 通用请求

#### 端点
任意 `stor.` 前缀端点。

#### 用途
在固定命令尚未覆盖某个存储端点时，发送受控的通用存储请求。

#### CLI 映射
```
fnos-cli storage request stor.<name> [--json '<object>'] [--password <password>] [--yes]
```

#### 请求规则
- `endpoint` 必须以 `stor.` 开头。
- 已有固定命令覆盖的端点会被拒绝；应改用对应固定命令。
- `--json` 必须是 JSON object。
- `--json` 不能包含 `req`、`reqid` 或 `password`；`req` / `reqid` 由 CLI 生成，密码只能通过 `--password` 传入。
- 默认需要交互确认；`--yes` 可跳过确认。
- 传 `--password` 时，CLI 会先通过密码验证，再把密码加入目标 `stor.*` 请求。

#### 使用说明
- 固定命令存在时优先使用固定命令，因为固定命令有更明确的本地校验和危险操作流程。
- 对不确定是否会修改设备状态的端点，应按危险操作处理，先执行只读探测并确认目标。

## 注意事项
- 存储池状态查询端点（`state` vs `state2`）的具体响应字段差异尚未完全确认。
- 部分高级端点（缓存设备操作、`stor.delRec`、`stor.lvActive` 等）尚未暴露。
- 所有通用响应都包含 `result`（`succ`/`fail`）、`errno` 和 `errmsg` 字段。
