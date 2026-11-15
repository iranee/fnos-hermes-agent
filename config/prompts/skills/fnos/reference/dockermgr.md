# dockermgr 模块

## 模块概述
Docker 管理模块，涵盖 Docker 镜像、容器、网络、Compose 项目和 Docker 守护进程生命周期操作。

## 模块约定
- 镜像、容器、网络、Compose 和系统级端点分组管理。
- 区分列表/查询端点和长时间运行的变更端点。
- 命名空间说明：历史文档使用 `appcgi.dockermgr.*`，部分代码使用 `dockermgr.*`（如 `dockermgr.containerList`）。自动化调用时优先使用 `appcgi.dockermgr.*`。

## 任务路由

先判断是观察类还是变更类：

| 用户意图 | 优先命令 | 说明 |
| --- | --- | --- |
| 看 Docker 总体状态 | `fnos-cli docker stats` | 适合作为进入 Docker 模块的只读探测 |
| 看镜像 | `fnos-cli docker image ls` / `inspect` | 需要镜像详情时再下钻 inspect |
| 拉镜像 | `fnos-cli docker image pull <imageRef> --yes` | 长耗时写操作，执行后应重新确认状态 |
| 看容器 | `fnos-cli docker container ls [--all]` / `inspect` / `stats` / `top` | `ls` 默认只列运行中容器；停止或创建态容器需要 `--all` |
| 启停、重启、强杀、删除容器 | `start/stop/restart/kill/rm` | 变更前建议先 inspect 或 ls |
| 看 Compose 项目 | `fnos-cli docker compose ls` | 目前优先作为只读入口 |

## 常见误判

- `docker stats` 是聚合统计，不是单容器统计
- `docker container ls` 默认不包含 stopped/created 容器；判断容器是否消失时使用 `docker container ls --all` 或按 ID 执行 `inspect`
- 列表接口成功但省略 `data` 时，只能确认请求成功，不能据此断言资源数量为 0；CLI 会保留原始成功信封，避免把后端漏字段伪装成空列表
- `image pull`、`container stop`、`container restart` 这类操作可能明显长于普通读请求
- `image pull` 与 `container create/update/start/stop/restart/kill` 必须显式传 `--yes`；删除命令可交互确认，但 Agent 或非交互流程也应传 `--yes`。`--force` 和 `--yes` 不是同一个概念
- `container update` 可能返回新 ID；CLI 会先 inspect 返回的 ID，确认本次资源字段已生效且网络配置未丢失后再报告成功。旧固件不返回 ID 时，CLI 会对原 ID 执行相同回查。后续操作使用命令输出的 ID
- 镜像引用和容器 ID 不是同一类标识，不要混传

## 高风险提醒

- 变更前先跑一条只读命令确认目标是否存在、当前状态是否符合预期
- 长耗时操作后要补一条只读命令确认结果，不要只看启动消息
- 删除类操作不应和不相关的镜像或容器清理打包在同一轮里
- 如果用户只说“把 Docker 弄一下”这类模糊目标，应先停下来确认是镜像、容器、网络还是 Compose

## 端点索引
- 镜像：
  - `appcgi.dockermgr.imageList`
  - `appcgi.dockermgr.imagePull`
  - `appcgi.dockermgr.imageInspect`
  - `appcgi.dockermgr.imageRemove`
  - `appcgi.dockermgr.imageDownloadList`（通过 `docker request`）
  - `appcgi.dockermgr.imageLoad`（通过 `docker request`）
  - `appcgi.dockermgr.imageSave`（通过 `docker request`）
  - `appcgi.dockermgr.imageUpgrade`（通过 `docker request`）
  - `appcgi.dockermgr.imageCancel`（通过 `docker request`）
- 容器：
  - `appcgi.dockermgr.containerList`
  - `appcgi.dockermgr.containerCreate`
  - `appcgi.dockermgr.containerInspect`
  - `appcgi.dockermgr.containerTop`
  - `appcgi.dockermgr.containerStats`
  - `appcgi.dockermgr.containerStart`
  - `appcgi.dockermgr.containerStop`
  - `appcgi.dockermgr.containerRestart`
  - `appcgi.dockermgr.containerKill`
  - `appcgi.dockermgr.containerRemove`
  - `appcgi.dockermgr.containerModify`
- 网络：
  - `appcgi.dockermgr.networkCreate`
  - `appcgi.dockermgr.networkList`
  - `appcgi.dockermgr.networkRemove`
  - `appcgi.dockermgr.networkConnect`
  - `appcgi.dockermgr.networkDisconnect`
- 系统和 Compose：
  - `appcgi.dockermgr.stats`
  - `appcgi.dockermgr.composeList`
  - `appcgi.dockermgr.systemStart`（通过 `docker request`）
  - `appcgi.dockermgr.systemStop`（通过 `docker request`）
  - `appcgi.dockermgr.systemRestart`（通过 `docker request`）
  - `appcgi.dockermgr.composeContainers`（通过 `docker request`）
  - `appcgi.dockermgr.composeCreate`（通过 `docker request`）
  - `appcgi.dockermgr.composeStart`（通过 `docker request`）
  - `appcgi.dockermgr.composeStop`（通过 `docker request`）

未封装为固定子命令的 `appcgi.dockermgr.*` 端点通过以下入口调用：

```bash
fnos-cli docker request appcgi.dockermgr.<name> --json '<object>' --yes
```

`--json` 必须是 JSON object，不能包含 `req` 或 `reqid`。泛化请求必须显式传 `--yes`，缺失时 CLI 会在读取 session 或访问网络前直接拒绝，不会进入交互提示；Docker system、network、Compose 和镜像导入导出类操作可能影响运行中服务，调用前应先执行只读探测。

## 端点详情

### appcgi.dockermgr.containerList

#### 端点
`appcgi.dockermgr.containerList`

#### 用途
列出 Docker 容器及其运行时摘要信息。

#### CLI 映射
```
fnos-cli docker container ls [--all]
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | 请求体 | 是 | string | 端点选择器 | 固定值 | `appcgi.dockermgr.containerList` |
| `reqid` | 请求体 | 是 | string | 请求关联 ID | 逐请求生成 | `69ba...` |
| `all` | 请求体 | 否 | boolean | 是否包含停止和创建态容器 | 仅 `--all` 时发送 `true`；默认只列运行中容器 | `true` |

#### 响应
| 字段 | 总是存在 | 类型 | 含义 | 条件 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- |
| `data` | 否 | array / object | 容器列表 | 格式可能因 Docker 版本而异 | `[{"name":"nginx","state":"running"}]` |
| `result` | 否 | string | 终态标记 | `succ`/`fail` | `succ` |
| `errno` | 否 | number | 错误码 | 失败时出现 | `65534` |
| `errmsg` | 否 | string | 错误描述 | | `docker not running` |

#### 协议说明
- 签名请求（当 session secret 可用时）。
- 历史名称别名：`dockermgr.containerList`。
- 判断容器在 update/stop 后是否仍存在时，使用 `--all` 或 `container inspect <id>`，不要仅凭默认列表下结论。

### appcgi.dockermgr.stats

#### 端点
`appcgi.dockermgr.stats`

#### 用途
返回 Docker 聚合统计信息。

#### CLI 映射
```
fnos-cli docker stats
```

#### 响应
| 字段 | 总是存在 | 类型 | 含义 | 条件 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- |
| `data` | 否 | object | 聚合统计 | 包含利用率指标 | `{"cpu":12.5,"mem":47.1}` |
| `result` | 否 | string | 终态标记 | `succ`/`fail` | `succ` |

#### 字段语义
- 聚合摘要端点；单容器指标使用 `containerStats`。

### appcgi.dockermgr.image.* 家族

#### 端点
`appcgi.dockermgr.imageList`、`imagePull`、`imageInspect`、`imageRemove`

#### 用途
管理 Docker 镜像（列表/拉取/检查/删除）。

#### CLI 映射
```
fnos-cli docker image ls
fnos-cli docker image pull <imageRef> --yes
fnos-cli docker image inspect <imageRef>
fnos-cli docker image rm <imageRef> [--force] [--yes]
```

#### 请求
| 字段 | 位置 | 必填 | 类型 | 含义 | 约束 / 说明 | 示例 |
| --- | --- | --- | --- | --- | --- | --- |
| `req` | 请求体 | 是 | string | 端点选择器 | 对应具体操作 | `appcgi.dockermgr.imageList` |
| `reqid` | 请求体 | 是 | string | 请求关联 ID | 逐请求生成 | `69ba...` |
| `fromImage` | 请求体 | 有条件 | string | 镜像名（imagePull） | 不含 tag 部分 | `nginx` |
| `tag` | 请求体 | 有条件 | string | 镜像标签（imagePull） | 未指定时默认 `latest` | `latest` |
| `imageId` | 请求体 | 有条件 | string | 镜像 ID 或引用（inspect/rm） | 可以是后端 ID 或如 `nginx:latest` | `nginx:latest` |
| `force` | 请求体 | 否 | boolean | 强制删除（imageRemove） | 仅 `--force` 时发送 | `true` |

#### 字段语义
- `imagePull` 分割 `<imageRef>` 为 `fromImage` 和 `tag`；保留 registry 端口，如 `registry:5000/ns/app:1.0` → `fromImage="registry:5000/ns/app"`, `tag="1.0"`。
- `imageRemove` 默认要求确认，`--yes` 跳过确认。
- Pull/upgrade 可能是长时间运行的操作。

### appcgi.dockermgr.container.* 变更/详情家族

#### 端点
容器创建、生命周期和观察端点

#### 用途
容器创建、启动/停止/重启/强杀/删除、检查、进程列表和统计。

#### CLI 映射
```
fnos-cli docker container create --image <imageRef> [--name <name>] [--start] [--restart] [--memory <mb>] [--cpu <shares>] [--env <key=value>] [--cmd <arg>] [--port <host:container[/proto]>] [--mount <source:target[:ro|rw]>] --yes
fnos-cli docker container update <containerId> [--restart] [--memory <mb>] [--cpu <shares>] --yes
fnos-cli docker container inspect <containerId>
fnos-cli docker container top <containerId>
fnos-cli docker container stats <containerId>
fnos-cli docker container start <containerId> --yes
fnos-cli docker container stop <containerId> --yes
fnos-cli docker container restart <containerId> --yes
fnos-cli docker container kill <containerId> --yes
fnos-cli docker container rm <containerId> [--force] [--yes]
```

#### 字段语义

**containerCreate：**
- `--image` 必填，映射到请求中的镜像引用
- `--name` 可选容器名
- `--start` 映射到 `startWhenCreated: true`
- `--restart` 映射到 `restart: true`
- `--memory <mb>` 将 MB 转换为字节（如 `128` → `134217728`）
- `--cpu <shares>` 转发正整数 CPU shares
- `--env <key=value>` 可重复，映射到 `env[]`
- `--cmd <arg>` 可重复，映射到 `cmd[]`
- `--port <host:container[/proto]>` 可重复，映射到 `port[]`；协议默认 `tcp`
- `--mount <source:target[:ro|rw]>` 可重复，映射到 `mount[]`；权限默认 `rw`
- 默认值：`restart=false`、`privileged=false`、`net=['bridge']`、`cpu=0`、`memory=0`
- `create/update/start/stop/restart/kill` 必须显式传 `--yes`；`rm` 可交互确认，但 Agent 或非交互流程应传 `--yes`。

**containerModify：** CLI 先读取完整容器配置，将资源变更合并到当前配置后提交。若响应带 `rsp.id`，CLI 会 inspect 该 ID，并核对 `name/image/restart/privileged/gpuEnabled/cpu/memory/env/cmd/capAdd/capDrop/link/mount/port/networks`；全部字段与提交配置一致后才报告成功，其中集合字段按无序内容比较，网络还会核对名称及静态地址。若旧固件省略 `rsp.id`，则对原 ID 执行相同回查。

**containerCreate 成功响应**可能为顶层 `rsp` 对象（Docker 风格大写 key，如 `{"Id":"abcd","Warnings":[]}`），而不是嵌套在 `data.rsp` 中。

**containerInspect/top/stats/start/stop/restart/kill：** 通过 `containerId` 标识。

`container top` 需要目标容器处于运行状态。CLI 会先 inspect；当 `State.Running=false` 时在本地返回明确提示，不再发送会产生设备 errno 的 top 请求。

**containerRemove：** 通过 `containerId` 标识；`force` 仅在 `--force` 时发送；默认要求确认，`--yes` 跳过。

#### 错误
- 常见错误：容器不存在、无效状态转换、权限不足。

### appcgi.dockermgr.composeList

#### 端点
`appcgi.dockermgr.composeList`

#### 用途
列出 Docker Compose 项目。

#### CLI 映射
```
fnos-cli docker compose ls
```

## 注意事项
- 镜像拉取/升级和 Compose 操作是长时间运行的，可能涉及进度/取消模式。
- Docker 守护进程的启动/停止/重启是高影响操作，可能影响运行中的容器。
- 部分端点的详细请求/响应 schema 尚未完全规范化。
