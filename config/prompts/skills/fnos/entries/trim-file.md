---
name: trim-file
description: 列出或搜索文件、上传本地文件、检查共享目录和 ACL，或判断当前用户目录与 NAS 路径语义时使用。
---

# 文件

先读 `../reference/workflows/file-routing.md` 选择命令，再读 `../reference/file.md` 查看端点字段。

## 规则

- `file ls` 和 `file ls /` 都省略请求的 `path`。
- 写操作默认要求具体 `/vol{n}/...` 路径。
- `file share.*` 管理共享目录，不是共享链接。
- `file search-others` 搜索别人共享给当前用户的文件，不是列出共享目录。
- `file upload` 接收远端目录，由 CLI 拼接本地文件名。
- `file check-upload` 可能分配临时占位；上传及其预检都需要 `--yes`。
- `file fav add/del` 修改当前用户收藏夹，需要 `--yes`。

## 命令

```bash
fnos-cli file ls
fnos-cli file ls /vol1/downloads
fnos-cli file search <key>
fnos-cli file upload /vol1/1000/uploads ./local-file.txt --overwrite rename --yes
fnos-cli file share list
fnos-cli file acl get /vol1/1000/docs
```
