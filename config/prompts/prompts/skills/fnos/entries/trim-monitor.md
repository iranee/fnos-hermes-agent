---
name: trim-monitor
description: 查看 CPU、内存、网络、磁盘、进程、服务、电池、风扇、GPU/NPU 与蜂鸣器告警等运行时指标。
---

# 监控

阅读 `../reference/resmon.md`。运行时指标使用 `monitor`；静态系统标识、机型与配置阅读 `trim-system.md`。

## 使用规则

- `monitor cpu` / `monitor memory` 返回时间序列采样，结合上下文解释 `usage`、`cores` 等字段。
- `monitor gen --item` 支持逗号分隔或重复参数，仅接受 `storeSpeed`、`netSpeed`、`cpuBusy`、`memPercent`。
- `monitor proc-info --pids` 接受逗号分隔的正整数 PID。
- 大部分命令只读；`monitor mute-beeper` 和 `monitor request` 需要确认或明确传入 `--yes`。
- `monitor request` 仅接受 `appcgi.resmon.*`；JSON 中不提供 `req` 和 `reqid`。

## 命令

```bash
fnos-cli monitor cpu
fnos-cli monitor memory
fnos-cli monitor net
fnos-cli monitor disk
fnos-cli monitor gen --item storeSpeed,netSpeed --item cpuBusy
fnos-cli monitor proc-list
fnos-cli monitor proc-info --pids 123,456
fnos-cli monitor proc-srv
fnos-cli monitor sys-warn
fnos-cli monitor battery
fnos-cli monitor sys-fan
fnos-cli monitor beep-supported
fnos-cli monitor beep-events
fnos-cli monitor beep-reasons
fnos-cli monitor mute-beeper --yes
fnos-cli monitor request appcgi.resmon.gen --json '{"item":["cpuBusy"]}' --yes
```
