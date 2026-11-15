---
name: trim-baidu-netdisk
description: 检查百度网盘授权、容量、云端文件、分享保存、NAS 传输和定时同步。
---

# 百度网盘

用于云文件浏览/搜索/元数据、文件变更、分享保存到 NAS、上传下载任务和定时同步。完整命令、字段和错误见 `../reference/baidu-netdisk.md`；fnOS profile 说明见 `trim-shared.md`。

## 规则

- 先运行 `baidu-netdisk status`；未授权时由用户在 NAS 百度网盘应用中完成授权。CLI 不执行百度 OAuth。
- 网盘路径以 `/` 开头；NAS 路径是具体 `/vol{n}/...` 路径，两者不可混用。
- 文件、传输和同步变更必须显式传入 `--yes`。
- `upload` 成功只表示任务提交，`data: null` 属正常情况。先查看 `task list --state running`，再用 `--state completed` 确认最终结果。
- `status=6`、`failCode=42610` 表示网盘空间不足；释放或扩展空间后再重试。
- `info --dlink` 返回敏感临时 URL；CLI 输出会对 `dlink` 脱敏。
- `move` / `copy` 最后一个参数是目标目录，其余参数是源路径。
- 优先使用 `share-save --all`。若精确选择已知分享 ID，则重复传入 `--fsid`；`--all` 和 `--fsid` 互斥。
- 自动识别分享提取码，也可用 `--password` 提供。分享短码、提取码、`spwd` 和中间任务 ID 不得出现在回复或日志中。

## 命令

```bash
fnos-cli baidu-netdisk status
fnos-cli baidu-netdisk quota
fnos-cli baidu-netdisk ls / --limit 80
fnos-cli baidu-netdisk search <keyword> --dir / --recursive
fnos-cli baidu-netdisk info <fsid...>
fnos-cli baidu-netdisk mkdir /backup --yes
fnos-cli baidu-netdisk upload /backup /vol1/1000/data --yes
fnos-cli baidu-netdisk download /vol1/1000/downloads <fsid...> --yes
fnos-cli baidu-netdisk share-save '<shareUrlWithPassword>' /vol1/1000/downloads --all --yes
fnos-cli baidu-netdisk task list --transfer download
fnos-cli baidu-netdisk sync list
```
