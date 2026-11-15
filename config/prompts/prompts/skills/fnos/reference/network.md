# network 模块

## 模块概述

网络模块用于管理设备网络相关服务开关。当前 CLI 覆盖 SSH 服务开关。

## 端点索引

- 已实现：
  - `appcgi.network.ssh.switch`（开启或关闭 SSH 服务）

## appcgi.network.ssh.switch

### 端点

`appcgi.network.ssh.switch`

### 用途

开启或关闭设备 SSH 服务。

### CLI 映射

```bash
fnos-cli network ssh switch --enable [--yes]
fnos-cli network ssh switch --disable [--yes]
```

### 请求

| 字段 | 位置 | 必填 | 类型 | 含义 | 约束 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | 请求体 | 是 | 字符串 | 端点选择器 | 固定值 | `appcgi.network.ssh.switch` |
| `reqid` | 请求体 | 是 | 字符串 | 请求关联 ID | 每次请求生成 | `69ba...` |
| `enable` | 请求体 | 是 | 布尔值 | 是否开启 SSH | `true` 开启，`false` 关闭 | `true` |

### 说明

- `--enable` 与 `--disable` 必须二选一。
- 开启 SSH 是安全敏感操作，默认需要确认；用户明确授权后才使用 `--yes`。
- 命令需要已登录 session，并通过认证链执行。
