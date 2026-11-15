# 文件路径与共享目录路由

先选命令，再读 `../file.md` 查看字段。

## 1. 对应用户意图

| 意图 | 优先命令 | 路径与语义规则 |
| --- | --- | --- |
| 列出当前可见目录 | `fnos-cli file ls` | 无参数与 `/` 都省略 `path`；不承诺返回所有卷 |
| 列出具体目录 | `fnos-cli file ls /vol{n}/...` | 区分聚合根与规范路径 |
| 搜当前用户的文件 | `fnos-cli file search <key>` | 让 CLI 探测并推导当前用户目录 |
| 搜指定目录 | `fnos-cli file search <key> /vol{n}/...` | 使用具体规范路径 |
| 上传本地文件 | `fnos-cli file upload /vol{n}/... <localFile> --yes` | 远端参数是目录，不是最终文件名 |
| 搜别人共享给我的文件 | `fnos-cli file search-others <key>` | 区别于共享目录列表 |
| 查看共享目录 | `fnos-cli file share info <path>` | 不是共享链接管理 |
| 列出可见共享目录 | `fnos-cli file share list [uid]` | 不是文件搜索 |
| 查看 ACL | `fnos-cli file acl get <path>` | 返回权限数据，不是共享目录状态 |
| 创建、删除、复制或移动文件 | `file mkdir/rm/cp/mv` | 具体路径并显式 `--yes` |

## 2. 确定路径

1. 写操作要求具体规范 `/vol{n}/...` 路径。
2. `file ls` 与 `file ls /` 均省略 `path`，都不是显式请求聚合根 `/`。
3. 无路径搜索让 CLI 通过 `file.ls` 探测当前用户目录。
4. 每个显式搜索路径必须为 `/vol{n}/...`。
5. 对别人共享的文件，按意图选择 `search-others` 或 `share list-others`。

## 3. 重要区别

- 共享目录使用 `file share.*`，不是共享链接。
- `file search-others` 返回匹配文件，不是共享目录列表。
- ACL 查询返回权限，不是共享状态。
- `file cp` / `file mv` 接收目标目录，不是最终文件名。
- 上传的 `uploadName` 是 HTTP 上传/续传路径，不一定是可见文件名。

## 4. 停止并澄清

写操作只给出 `/`、相对或含糊路径；用户要求共享链接但仅有共享目录接口；搜索路径混有非规范路径；或假设当前用户目录为固定值时，先澄清。

字段见 [file.md](../file.md)，上传见 [file-upload-validation.md](file-upload-validation.md)。构造请求前先确定路径语义。
