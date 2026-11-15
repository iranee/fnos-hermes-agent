---
name: trim-photos
description: 浏览相册扫描目录、搜索照片、查看详情，以及获取缩略图或原图预览地址时使用。
---

# 照片

Photos 通过原生 HTTP API 代理复用当前 profile 的系统 OAuth 登录状态。字段见 `../reference/photos.md`；统计、AI 搜索和抽样预览见 `../reference/workflows/photos-routing.md`。

## 规则

- 先完成 OAuth `login`；Photos 不需要单独应用登录或签名。
- `--filter` 与 `--exclude-filter` 接收可重复的 `name=value` 参数。
- 预览尺寸为 `xxs`、`xs`、`s`、`m` 和 `o`（原图）。
- 预览 URL 是绝对地址，但浏览器通常仍需要已登录 fnOS 的 cookie。
- 自然语言 AI 搜索使用 `magic-search`，不是 `photos search` 的别名。缺少稳定 `total` 时，只报告本次返回条数。
- 未封装端点使用 `photos request`；非 GET 请求默认需要确认。
- 同时检查 `httpStatus` 与 `response.code`，不能只看 CLI 退出码。

## 命令

```bash
fnos-cli photos folders
fnos-cli photos search IMG --limit 20
fnos-cli photos search 北京 --filter file_type=photo
fnos-cli photos info <photoId>
fnos-cli photos preview <photoId> --size m
fnos-cli photos preview <photoId> --size o --open
```
