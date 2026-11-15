# sysinfo 模块

## 模块概述
系统信息模块，涵盖机器标识、版本/硬件详情、主机/时间设置、风扇配置和电源计划调度。

## 模块约定
- 使用 `appcgi.sysinfo.*` 命名空间。
- 只读信息端点和配置变更端点应分开处理。

## 端点索引
- 已实现：
  - `appcgi.sysinfo.getTrimMachineType`
  - `appcgi.sysinfo.getTrimVersion`
  - `appcgi.sysinfo.getKernelVersion`
  - `appcgi.sysinfo.getHostName`
  - `appcgi.sysinfo.getMachineId`
  - `appcgi.sysinfo.getUptime`
  - `appcgi.sysinfo.getAllVolsInfo`
  - `appcgi.sysinfo.getVolsList`
  - `appcgi.sysinfo.getDockerInfo`
  - `appcgi.sysinfo.getUnixTime`
  - `appcgi.sysinfo.getBootOnPowerFlag`
  - `appcgi.sysinfo.getHardwareInfo`
  - `appcgi.sysinfo.getReservedPartition`
  - `appcgi.sysinfo.isTrimMachine`
  - `appcgi.sysinfo.getTrimMachineFeature`
  - `appcgi.sysinfo.getFanMode`
  - `appcgi.sysinfo.getTrimDisk`
  - `appcgi.sysinfo.getTimeSetting`
  - `appcgi.sysinfo.getTimezoneList`
  - `appcgi.sysinfo.listPowerPlan`
  - `appcgi.sysinfo.nextPowerOffTime`
  - `appcgi.sysinfo.getPowerPlanStatus`
  - `appcgi.sysinfo.getPowerOnSeconds`
  - `appcgi.sysinfo.getSystemInitedTimestamp`
  - `appcgi.sysinfo.*` 泛化请求（通过 `system request`）
- 未实现：
  - 主机/时间设置写操作：`setHostName`、`setTimeSetting`
  - 电源计划写操作：`setPowerPlanStatus`、`addPowerPlan`、`deletePowerPlan`、`modifyPowerPlan`
  - 风扇模式写操作：`setFanMode`

## 端点详情

### appcgi.sysinfo.getTrimMachineType

#### 端点
`appcgi.sysinfo.getTrimMachineType`

#### 用途
返回 NAS 机器类型标识信息。

#### CLI 映射
```
fnos-cli system info
```

CLI 行为：
- 不要求已保存的 session。
- 将 `response.data` 以 JSON 格式打印；如果 `data` 不存在则报错。

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | 请求体 | 是 | 字符串 | 端点选择器 | 固定值 `appcgi.sysinfo.getTrimMachineType` | `appcgi.sysinfo.getTrimMachineType` |
| `reqid` | 请求体 | 是 | 字符串 | 请求关联 ID | 每次请求生成 | `69ba...` |

#### 响应
| 字段 | 始终存在 | 类型 | 含义 | 条件 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- |
| `data` | 否 | 对象 | 机器类型信息 | CLI 优先提取此字段 | `{"type":"trim-xx"}` |
| `result` | 否 | 字符串 | 终态标记 | `succ`/`fail` | `succ` |
| `errno` | 否 | 数值 | 错误码 | 失败时出现 | `65534` |
| `errmsg` | 否 | 字符串 | 错误描述 | 失败时出现 | `permission denied` |

#### 协议说明
- 使用普通 JSON 请求。

#### 字段语义
- 返回数据的具体字段由后端定义，可能因机型和固件版本而异。

#### 错误
- 后端错误通过统一格式化器输出。
- 缺少 `data` 时命令会以非零退出码失败。

### 其他只读端点

以下端点均为只读查询，不要求已保存 session，并打印响应 `data` 对象。

| CLI 命令 | 端点 | 请求参数 | 用途 |
| --- | --- | --- | --- |
| `fnos-cli system trim-version` | `appcgi.sysinfo.getTrimVersion` | 无 | 系统版本 |
| `fnos-cli system kernel-version` | `appcgi.sysinfo.getKernelVersion` | 无 | 内核版本 |
| `fnos-cli system host-name` | `appcgi.sysinfo.getHostName` | 无 | 主机名 |
| `fnos-cli system machine-id` | `appcgi.sysinfo.getMachineId` | 无 | 机器 ID |
| `fnos-cli system uptime` | `appcgi.sysinfo.getUptime` | 无 | 系统运行时间 |
| `fnos-cli system all-vols` | `appcgi.sysinfo.getAllVolsInfo` | 无 | 全部卷信息 |
| `fnos-cli system vols` | `appcgi.sysinfo.getVolsList` | 无 | 卷列表 |
| `fnos-cli system docker` | `appcgi.sysinfo.getDockerInfo` | 无 | Docker 相关系统信息 |
| `fnos-cli system unix-time` | `appcgi.sysinfo.getUnixTime` | 无 | 系统 Unix 时间 |
| `fnos-cli system boot-on-power` | `appcgi.sysinfo.getBootOnPowerFlag` | 无 | 通电启动标记 |
| `fnos-cli system hardware` | `appcgi.sysinfo.getHardwareInfo` | 无 | 硬件信息 |
| `fnos-cli system reserved-partition` | `appcgi.sysinfo.getReservedPartition` | 无 | 预留分区信息 |
| `fnos-cli system is-trim-machine` | `appcgi.sysinfo.isTrimMachine` | 无 | 是否为 TRIM 机器 |
| `fnos-cli system trim-feature` | `appcgi.sysinfo.getTrimMachineFeature` | 无 | 机器能力特性 |
| `fnos-cli system fan-mode` | `appcgi.sysinfo.getFanMode` | 无 | 风扇模式 |
| `fnos-cli system trim-disk` | `appcgi.sysinfo.getTrimDisk` | 无 | 系统盘/机器磁盘信息 |
| `fnos-cli system time-setting --lang zh-CN` | `appcgi.sysinfo.getTimeSetting` | 可选 `lang` | 时间设置 |
| `fnos-cli system timezone-list --lang zh-CN` | `appcgi.sysinfo.getTimezoneList` | 可选 `lang` | 时区列表 |
| `fnos-cli system power-plan` | `appcgi.sysinfo.listPowerPlan` | 无 | 电源计划列表 |
| `fnos-cli system next-power-off-time` | `appcgi.sysinfo.nextPowerOffTime` | 无 | 下一次关机时间 |
| `fnos-cli system power-plan-status` | `appcgi.sysinfo.getPowerPlanStatus` | 无 | 电源计划启用状态 |
| `fnos-cli system power-on-seconds` | `appcgi.sysinfo.getPowerOnSeconds` | 无 | 通电秒数 |
| `fnos-cli system inited-timestamp` | `appcgi.sysinfo.getSystemInitedTimestamp` | 无 | 系统初始化时间戳 |

### 泛化请求

| CLI 命令 | 端点 | 请求参数 | 风险控制 |
| --- | --- | --- | --- |
| `fnos-cli system request appcgi.sysinfo.* --json '<object>'` | 用户指定的 `appcgi.sysinfo.*` 端点 | JSON 对象，不能包含 `req` 或 `reqid` | 默认需要确认；可用 `--yes` 跳过 |

泛化请求约束：
- endpoint 必须以 `appcgi.sysinfo.` 开头。
- `--json` 必须是 JSON object。
- `req` 和 `reqid` 由 CLI 生成，用户 JSON 中禁止提供这两个字段。
- `system request` 是泛化入口，不区分读写端点，默认统一要求确认。
- `system request` 使用已保存 session 认证；如果当前目标与保存 session 不一致，会先失败而不是匿名发送配置请求。

## 注意事项
- 返回数据的具体字段结构可能因 NAS 机型和固件版本而异。
- 当前固定子命令均为读取型查询。
- 定时开关机功能依赖设备声明的硬件能力。`system power-plan` 收到成功但没有 `data` 的响应时输出 `{"plan":[]}`，与空计划列表一致；空列表不表示硬件支持定时开机。其他系统查询仍会拒绝缺少 `data` 的响应。
- `errno 100060031` 表示该功能仅受官方硬件支持，CLI 会显示英文提示 `this feature is supported only on official hardware`。`boot-on-power`、`trim-disk`、`power-on-seconds` 等硬件相关查询可能返回该错误。
- 电源计划、主机名、时间设置和风扇模式的配置端点尚未作为固定命令实现；如需调用，应通过 `system request` 并确认风险。
