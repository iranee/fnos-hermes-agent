---
name: trim-system
description: 查看静态系统标识、机型、版本、卷、硬件和电源计划，或重启、关闭设备。
---

# 系统与电源

阅读 `../reference/sysinfo.md` 和 `../reference/power.md`。分别调用对应 `system` 命令查询硬件、卷和电源计划。

## 使用规则

- 静态标识与配置属于本模块；CPU、内存等运行时指标阅读 `trim-monitor.md`。
- 固定 `system` 命令只读；通用 `system request` 默认需要确认或明确传入 `--yes`。
- `power reboot` / `power poweroff` 会中断服务。确认目标和用户授权后才使用 `--yes`。
- `system request` 仅接受 `appcgi.sysinfo.*`；JSON 中不提供 `req` 和 `reqid`。
- 通用请求使用已保存的会话认证，先登录目标设备。
- 机器类型与版本字段可能随 CLI/固件变化。以当前 `system info` 输出为准；意外或空字段应报告为可能的版本差异，不能编造值。

## 命令

```bash
fnos-cli system info
fnos-cli system trim-version
fnos-cli system kernel-version
fnos-cli system host-name
fnos-cli system machine-id
fnos-cli system uptime
fnos-cli system all-vols
fnos-cli system vols
fnos-cli system docker
fnos-cli system unix-time
fnos-cli system boot-on-power
fnos-cli system hardware
fnos-cli system reserved-partition
fnos-cli system is-trim-machine
fnos-cli system trim-feature
fnos-cli system fan-mode
fnos-cli system trim-disk
fnos-cli system time-setting --lang zh-CN
fnos-cli system timezone-list --lang zh-CN
fnos-cli system power-plan
fnos-cli system next-power-off-time
fnos-cli system power-plan-status
fnos-cli system power-on-seconds
fnos-cli system inited-timestamp
fnos-cli system request appcgi.sysinfo.getTrimVersion --yes
```

## 电源操作

```bash
fnos-cli power reboot --yes
fnos-cli power poweroff --yes
```
