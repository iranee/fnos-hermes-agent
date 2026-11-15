---
name: trim-network
description: 管理网络服务开关，包括开启或关闭 SSH，并确认写操作的授权要求。
---

# 网络

字段约束阅读 `../reference/network.md`；连接与会话规则阅读 `trim-shared.md`。

## 使用规则

- 开启 SSH 是安全敏感操作，必须得到用户明确授权。
- 确认授权后，Agent 命令明确传入 `--yes`。
- `--enable` 和 `--disable` 必须且只能选择一个。

## 命令

```bash
fnos-cli network ssh switch --enable --yes
fnos-cli network ssh switch --disable --yes
```
