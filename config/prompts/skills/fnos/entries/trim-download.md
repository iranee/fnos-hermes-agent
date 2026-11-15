---
name: trim-download
description: 列出、搜索、创建和控制下载任务，查看任务文件、统计和状态变化。
---

# 下载

命令格式及端点字段见 `../reference/download.md`。本模块用于 URI、磁力链接和种子任务、保存目录、优先级与任务重试。

## 规则

- 创建任务使用 `download add-uri <uri> <saveDir>` 或 `download add-path <path> <saveDir>`；保存目录必须是具体 `/vol{n}/...` 路径。
- `download stat` 返回汇总统计，不是单文件元数据。
- `download pause|resume|retry|rm <id...>` 操作现有任务，不推断文件路径。
- 创建和控制任务必须显式传入 `--yes`。
- `download info` / `download files` 中的路径直接反映 fnOS 卷定义；使用返回路径，不自行推导替代路径。
- 未封装的 `appcgi.downloadcenter.*` 端点使用 `download request`；JSON 中不填写 `req` 和 `reqid`。

## 命令

```bash
fnos-cli download ls
fnos-cli download ls installer
fnos-cli download info <id>
fnos-cli download files <id>
fnos-cli download add-uri https://example.com/file.iso /vol1/download --yes
fnos-cli download add-path /vol1/source.torrent /vol1/download --yes
fnos-cli download pause <id...> --yes
fnos-cli download resume <id...> --yes
fnos-cli download retry <id...> --yes
fnos-cli download rm <id...> --yes
fnos-cli download stat
fnos-cli download request appcgi.downloadcenter.tracker.query --json '{}' --yes
```
