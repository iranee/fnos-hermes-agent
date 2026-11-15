---
name: trim-storage
description: 查看存储池、磁盘与 SMART 数据，或执行挂载、扩容、磁盘替换、格式化等高风险存储写操作。
---

# 存储

写操作前阅读 `../reference/workflows/storage-dangerous-ops.md`；API 契约阅读 `../reference/stor.md`。

## 使用规则

- 池使用 UUID 或 `trim_*` 标识；磁盘使用 `sda`、`nvme0n1` 等纯设备名。
- 高风险写操作前先执行 `storage pools` 和 `storage disks`。
- 创建存储池前执行 `storage free-disks`。使用系统盘剩余空间时，以返回的 `part` 为目标，不用整盘名称。
- 缺少必需的验证密码时停止，不假定默认密码。
- 优先使用固定命令；`storage request` 会拒绝已有固定命令覆盖的端点。

## 命令

```bash
fnos-cli storage overview
fnos-cli storage pools
fnos-cli storage disks
fnos-cli storage free-disks
fnos-cli storage disk-info <disk>
fnos-cli storage disk-mount <disk> --yes
fnos-cli storage disk-umount <disk> --yes
fnos-cli storage smart <disk>
fnos-cli storage health <disk>
fnos-cli storage request stor.getConf --json '{"uuid":"trim_pool"}' --yes
```
