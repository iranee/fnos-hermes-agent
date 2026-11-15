# 照片任务路由

用于图库统计、条件搜索、AI 语义搜索和抽样预览。选定命令后读取照片参考文档。

## 1. 授权

Photos 复用当前 profile 的代理登录状态。没有有效状态时，按 `../oauth.md` 执行：Agent 生成授权链接，用户在浏览器授权并回传 code，再由 Agent 完成交换。用户无需终端；凭据和同意操作留在浏览器。

多设备场景显式选择 `--profile`、`--host` 和 `--port`。不同设备状态不能互换。

## 2. 场景

### 图库范围与大小

```bash
fnos-cli photos folders
```

按扫描目录汇总返回的照片/视频数量。Photos 仅索引已加入扫描的目录；文件系统图片数量不等于图库索引数量。

### 条件搜索与计数

```bash
fnos-cli photos search 北京 --limit 20
fnos-cli photos search IMG --filter file_type=photo --limit 20
```

响应 `total` 表示全部匹配数，`list` 是本次返回样本。预览时选少量有代表性的结果执行 `photos preview <id> --size m`，不要获取所有原图。

### 自然语言 AI 搜索

先检查模型就绪状态：

```bash
fnos-cli photos request post /api/v1/magic-search/ready --yes
fnos-cli photos request post /api/v1/magic-search/do \
  --json '{"keyword":"海边日落","antiFilters":[]}' --yes
```

AI 搜索与条件 `photos search` 是不同端点。通常返回 `response.data.list`，没有稳定 `total`，因此只报告本次返回条数。模型缺失、未就绪或不支持查询语言时报告业务错误；文件名搜索的回落结果不能称为 AI 结果。

`photos request` 保留原始信封，即使 `response.code != 0` 也可能退出 0。两次调用都必须满足 `httpStatus` 为 `200..299` 且 `response.code == 0`。从 `response.data.list` 选 ID 再取预览。

### 抽样预览

```bash
fnos-cli photos preview <id> --size m
fnos-cli photos preview <id> --size o
```

优先中等预览；用户要求原图时才使用 `--size o`。

## 3. 计数与链接

| 结果 | 含义 | 注意事项 |
| --- | --- | --- |
| 条件搜索 `total` | 全部匹配数 | 不是当前 `list` 长度 |
| AI `list` 长度 | 本次返回条数 | 缺少 `total` 时不是精确总数 |
| `previewUrl` | 缩略图、原图或视频预览 | 浏览器通常仍需已登录 fnOS 的 cookie |

安全存储 token 保持私密，保留 CLI 对敏感 URI 的脱敏处理。

## 4. 停止并澄清

AI 结果缺少 `total` 却要求精确总数、未登录浏览器却要求公开预览，或仅预览却会获取全部原图时，先澄清。`httpStatus` 非 2xx 或 `response.code` 非零时停止。

字段、过滤器和 AI 端点见 [photos.md](../photos.md)。设备差异应以实际目标验证为准，记录不支持或未验证的行为；另一设备的成功不能证明兼容。
