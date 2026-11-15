# 高风险存储操作

先探测只读状态，再判断能否执行存储写操作。

## 1. 识别高风险写操作

执行 `storage umount/create/stop/add-disk/remove-disk/replace-disk/resize/extend/format/eject/disk-mount/disk-umount` 前使用本流程。`storage request` 只有在端点明确只读时才能免除此风险判断。

`storage mount` 风险较低，但仍需确认池标识和当前状态。可移动磁盘挂载/卸载必须明确磁盘目标。

## 2. 只读探测

1. `fnos-cli storage pools`。
2. `fnos-cli storage disks`。
3. 创建存储池前执行 `fnos-cli storage free-disks`。
4. 按需执行 `fnos-cli storage health <disk>` 或 `storage smart <disk>`。
5. 可移动设备使用 `storage removable` 和 `storage disk-info <disk>`。

确认目标是池 UUID / `trim_*` 标识还是纯磁盘名，并确认其状态及是否可移动。系统盘剩余空间使用返回的 `part`，不用整盘 `name`。区分磁盘操作与存储池操作。

## 3. 密码与确认策略

| 策略 | 命令 |
| --- | --- |
| 验证并转发密码 | `umount`、`create`、`stop`、`add-disk`、`remove-disk`、`replace-disk`、`resize` |
| 仅验证，不转发 | `extend`、`format`、`eject` |
| 仅确认，不验密 | `mount`、`disk-mount`、`disk-umount` |
| 通用请求 | `request` 需要确认；明确提供的 `--password` 会被验证并转发 |

Agent/非交互写操作明确传入 `--yes`。前两行命令缺少必需密码时停止，不假定默认值。可能修改状态的 `stor.*` 请求按高风险处理。

## 4. 区分操作

- `mount` 不是 `stop` 的逆操作，先检查存储池状态。
- `extend` 与 `resize` 是不同操作。
- `format` / `eject` 面向可移动设备，不面向普通存储池。
- 池使用 UUID 或 `trim_*`，不用旧 `name` 字段。
- 磁盘使用 `sda`、`nvme0n1` 等纯名称，不用 `/dev/sda`。

## 5. 停止并澄清

目标池/磁盘不明确、探测结果与用户描述不一致、缺少必需密码，或目标已停止、未挂载、不可扩展以及磁盘休眠/异常时，先停止。

确认目标与操作顺序后阅读 [stor.md](../stor.md)。否则保持只读探测，不继续写操作。
