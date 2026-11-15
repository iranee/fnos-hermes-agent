---
name: trim-log
description: 浏览筛选日志、列举日志模块、清除或导出记录、配置归档，并复制或取消诊断日志。
---

# 日志

查询日志结构和命令参数时，阅读 `../reference/log.md`。

## 使用规则

- 筛选和导出时明确选择 `level`、`module`、`locale`。
- 旧版 `log.*` 与 `appcgi.eventlogger.common.*`（`logger`）可共存，分别解释返回结果。
- `logger export` 数据量可能较大，先确认输出存储可写。`logger archive set` 会修改策略，先确认预期配置。
- `diagnostic-log export --output-dir` 指设备侧已挂载路径，例如 `/vol1/<dir>` 或 `/vol00/<mount>/<dir>`。
- 清空日志或修改归档前，先用分页 `logger list` 查看当前状态。
- 清除、导出、归档设置及诊断任务控制，均明确传入 `--yes`。

## 命令

```bash
fnos-cli logger list --page <n> --page-size <n> --level <n> --module <n> --locale <locale>
fnos-cli logger modules --locale <locale>
fnos-cli logger clear --level <level> --module <module> --yes
fnos-cli logger export --level <level> --module <module> --locale <locale> --yes
fnos-cli logger archive set --switch <0|1> --file-path <path> --size-gt <n> --date-unit <n> --date-before <n> --yes
fnos-cli logger archive query
fnos-cli diagnostic-log export --output-dir /vol1/<dir> --srv-type 0,1,2 --yes
fnos-cli diagnostic-log stop --task-id <taskId> --yes
```
