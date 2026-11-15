# 上传验证

验证小文件、同名处理策略和可续传大文件。

## 1. 前提

- 已登录目标 NAS。
- 用户确认可写的 `/vol{n}/...` 目录。
- 已存在的本地普通文件。

## 2. 小文件

1. 在已确认可写目录中创建临时子目录。
2. 上传小于 20 MiB 的本地文件：

```bash
fnos-cli file upload /vol1/1000/tmp-upload ./demo.txt --overwrite rename --yes
```

3. 列出临时目录：

```bash
fnos-cli file ls /vol1/1000/tmp-upload
```

4. 确认 CLI 报告用户请求的目标路径，目录中有对应文件名。

## 3. 大文件

1. 准备至少 20 MiB 的本地文件。
2. 上传：

```bash
fnos-cli file upload /vol1/1000/tmp-upload ./large.bin --overwrite rename --yes
```

3. 列出目录，确认远端存在原文件名。
4. 排查续传时，检查本地配置目录中的上传缓存。其 `upload_path` 是后端 `.~#n` 上传路径，不是最终文件名。
5. 只有 endpoint、profile、登录用户、远端目标、文件大小、覆盖策略和本地 SHA-256 全部匹配才续传。同一本地路径下大小相同但内容不同的文件必须重新 `check-upload`。
6. 同一 endpoint 和远端目标的上传跨进程串行执行；等待锁本身不表示缓存损坏。

## 4. 清理

核对准确临时路径后，删除上传文件和目录：

```bash
fnos-cli file rm /vol1/1000/tmp-upload/demo.txt --yes
fnos-cli file rm /vol1/1000/tmp-upload/large.bin --yes
fnos-cli file rm /vol1/1000/tmp-upload --yes
```

## 5. 完成条件

成功输出使用用户请求的路径，`file ls` 能看到上传文件。小文件不依赖续传缓存；大文件可能创建缓存，缓存路径用于 HTTP 上传/续传，不是可见结果路径。旧缓存、缺少身份字段的缓存，以及本地指纹不一致的缓存都不得续传。
