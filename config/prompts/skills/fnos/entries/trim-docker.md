---
name: trim-docker
description: 查看和管理 Docker 镜像、容器、Compose 项目及长时间运行的生命周期操作。
---

# Docker

API 契约见 `../reference/dockermgr.md`。变更前先使用 `docker stats`、`image ls` 和 `container ls` 观察状态。

## 规则

- `container ls` 只列运行中容器。检查停止/创建态容器或确认容器是否仍存在时使用 `--all` 或 `container inspect <id>`。
- `container top` 要求容器运行中；先确认 `State.Running=true`。
- 拉取镜像和停止/重启容器可能比普通读请求耗时更长。
- `image pull` 和 `container create/update/start/stop/restart/kill` 必须传入 `--yes`。Agent 或非交互删除也要传入 `--yes`；`--force` 不能替代确认。
- `container update` 可能返回新 ID；旧固件也需要后续资源和网络检查。后续操作使用命令返回的 ID。
- 镜像引用与容器 ID 是不同标识。
- 未封装的 `appcgi.dockermgr.*` 端点使用 `docker request`，并显式传入 `--yes`。系统/网络/Compose 写操作前先只读探测。

## 命令

```bash
fnos-cli docker stats
fnos-cli docker image ls
fnos-cli docker image pull <imageRef> --yes
fnos-cli docker container ls
fnos-cli docker container ls --all
fnos-cli docker compose ls
fnos-cli docker request appcgi.dockermgr.networkList --json '{}' --yes
```
