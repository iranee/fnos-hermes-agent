---
name: fnos-dev-api
description: fnOS 应用开发（.fpk / Docker 应用 / 开放 API）规范，以及无 fnos-cli 时直连 WebSocket API 的认证签名参考
---

# fnOS 开发与 API 参考

> **操作 fnOS 优先用官方 `fnos-cli`**（技能 `skills/fnos/SKILL.md`）。本文只保留 fnos-cli 不覆盖的内容：应用开发规范、开放 API、以及 fnos-cli 不可用时的 WS 直连备用方案。
> Docker 排障见 `fnos-sysadmin`；Hermes 自身运维见 `hermes-workflows`。
> 官方文档：<https://developer.fnnas.com/docs/guide/>，本文按 2026-11-10 的官方文档核对。fnOS 迭代快，字段以当前官方文档为准。

---

# 第一部分：.fpk 应用开发规范

## 一、打包结构

`.fpk` 由 `fnpack` 打包生成（官方未公开内部格式，不要当作普通 tar.gz 手工拆装）。

```
<appname>/
├── manifest              ← 应用元数据（INI，无扩展名）
├── LICENSE               ← 可选，安装时展示
├── ICON.PNG              ← 图标 64×64
├── ICON_256.PNG          ← 图标 256×256
├── app/                  ← 应用运行文件（安装后 = $TRIM_APPDEST）
│   ├── ui/
│   │   ├── config        ← 桌面入口配置（JSON）
│   │   └── images/
│   ├── index.cgi         ← 可选：CGI 入口（见第七节）
│   └── docker/docker-compose.yaml   ← 仅 Docker 应用
├── cmd/                  ← 生命周期脚本（chmod +x）
│   ├── main              ← start / stop / status
│   ├── install_init / install_callback
│   ├── upgrade_init / upgrade_callback
│   ├── uninstall_init / uninstall_callback
│   └── config_init / config_callback
├── config/
│   ├── privilege         ← 权限声明（JSON）
│   └── resource          ← 资源声明（JSON：共享、网关、Docker 项目、api-scope）
└── wizard/               ← 向导（JSON，可选）：install / upgrade / uninstall / config
```

## 二、manifest 字段

INI 格式 `key=value`（本仓库用 `key = value` 对齐写法，两者均可）。官方文档不再区分必填/选填。最小可用示例包含 `appname` `version` `display_name` `desc` `maintainer` `maintainer_url` `source` `platform` `ctl_stop`。

| 字段 | 说明 |
|------|------|
| `appname` | 应用 ID，小写字母/数字/连字符；同时是应用用户名，安装后不可改 |
| `version` | 语义化版本，升级必须大于已安装版本 |
| `display_name` / `desc` | 显示名与描述（可带引号，desc 支持 HTML） |
| `source` | 第三方应用固定 `thirdparty` |
| `platform` | `x86` / `arm` / `all`（`arch` 字段 2025-12-31 起废弃） |
| `maintainer` / `maintainer_url` | 开发者与主页 |
| `distributor` / `distributor_url` | 发布者（与开发者不同时填写） |
| `service_port` / `checkport` | 服务端口 / 启动前是否检查端口占用 |
| `ctl_stop` | 是否显示启停按钮 |
| `os_min_version` / `os_max_version` | 支持的 fnOS 版本范围。使用网关需 `1.1.3100`，使用开放 API 需 `1.2.0401` |
| `install_type` | 空=用户选卷，`root`=系统分区 |
| `install_dep_apps` | 依赖应用，`:` 分隔，`>` 指定最低版本（见第十一节） |
| `install_reboot` / `upgrade_reboot` | 安装/升级后是否要求重启 |
| `desktop_uidir` / `desktop_applaunchname` | UI 目录（默认 `ui`）/ 多入口默认入口 ID |
| `micro_app` | `true` 表示使用 `@trimjs/web-app` SDK 的开放 API 应用（见第二部分） |
| `changelog` | 更新说明。官方文档与示例存在 `changelog` / `change_log` 两种写法，以 fnpack 当前模板为准 |
| `disable_authorization_path` | 隐藏授权目录设置 |

不存在的字段（旧资料常见错误）：`icon` `icon256` `main` `category` `description`（用 `desc`）`developer`（用 `maintainer`）`arch`（用 `platform`）`port`（用 `service_port`）`required` `min_fnos`。

## 三、安装后目录结构

```
/var/apps/{appname}/
├── cmd/  config/  manifest  ICON*.PNG  wizard/
├── target -> /vol{n}/@appcenter/{appname}   TRIM_APPDEST   程序文件，升级整体替换
├── etc    -> /vol{n}/@appconf/{appname}     TRIM_PKGETC    配置
├── var    -> /vol{n}/@appdata/{appname}     TRIM_PKGVAR    运行数据，升级保留
├── tmp    -> /vol{n}/@apptemp/{appname}     TRIM_PKGTMP    临时文件
├── home   -> /vol{n}/@apphome/{appname}     TRIM_PKGHOME   用户数据，升级保留
├── meta                                      TRIM_PKGMETA
└── share/ -> /vol{n}/@appshare/<name>        data-share 声明的共享目录
```

卷号由用户安装时选择，脚本一律用环境变量，不硬编码 `vol1`。

## 四、生命周期脚本

| 脚本 | 时机 | 要点 |
|------|------|------|
| `install_init` / `install_callback` | 安装文件复制前 / 后 | callback 中初始化数据目录、读取向导变量 |
| `upgrade_init` / `upgrade_callback` | 升级前 / 后 | callback 时 `$TRIM_PKGVAR` `$TRIM_PKGHOME` 已是旧数据，`$TRIM_APPDEST` 已是新文件 |
| `uninstall_init` / `uninstall_callback` | 卸载前 / 后 | 是否保留数据取决于向导选择 |
| `config_init` / `config_callback` | 配置变更前 / 后 | 对应 `wizard/config` |
| `main start|stop|status` | 运行控制 | `status` 退出码 0=运行中，3=未运行，1=异常 |

规则：
- 脚本退出码非 0 视为失败并中止流程。把用户可见的错误写入 `$TRIM_TEMP_LOGFILE` 再 `exit 1`，应用中心会展示。
- 脚本必须幂等：安装、升级、配置流程都可能被重复执行。
- 脚本以 root 执行。运行进程身份由 `config/privilege` 决定，数据目录需 `chown` 给 `$TRIM_USERNAME`。
- **Docker 应用**：fnOS 按 `docker-project` 声明托管容器启停，`cmd/main` 只需实现 `status`。

## 五、环境变量

| 分组 | 变量 |
|------|------|
| 应用信息 | `TRIM_APPNAME` `TRIM_APPVER` `TRIM_OLD_APPVER` `TRIM_APP_STATUS`（INSTALL/START/UPGRADE/UNINSTALL/STOP/CONFIG） |
| 路径 | `TRIM_APPDEST` `TRIM_PKGETC` `TRIM_PKGVAR` `TRIM_PKGTMP` `TRIM_PKGHOME` `TRIM_PKGMETA` `TRIM_APPDEST_VOL` |
| 用户 | `TRIM_USERNAME` `TRIM_GROUPNAME` `TRIM_UID` `TRIM_GID`（应用用户）；`TRIM_RUN_*`（当前执行脚本的用户） |
| 网络/资源 | `TRIM_SERVICE_PORT` `TRIM_DATA_SHARE_PATHS`（`:` 分隔）`TRIM_DATA_ACCESSIBLE_PATHS`（用户授权目录） |
| 日志/临时 | `TRIM_TEMP_LOGFILE` `TRIM_TEMP_UPGRADE_FOLDER` `TRIM_PKGINST_TEMP_DIR` `TRIM_TEMP_TPKFILE` |
| 系统 | `TRIM_SYS_VERSION` `TRIM_SYS_VERSION_MAJOR/MINOR/BUILD` `TRIM_SYS_ARCH` `TRIM_KERNEL_VERSION` `TRIM_SYS_MACHINE_ID` `TRIM_SYS_LANGUAGE` |
| 向导 | 向导字段 `field` 名即环境变量名（建议 `wizard_` 前缀） |
| 开放 API | `TRIM_API_TOKEN`（声明 `api-scope` 后由系统注入） |

取第一个 data-share：`DATA_DIR="${TRIM_DATA_SHARE_PATHS%%:*}"`。SSH 调试时这些变量不存在，需手工导出。

## 六、config/resource

```json
{
  "data-share": {
    "shares": [
      { "name": "myapp", "permission": { "rw": ["myapp"], "ro": [] } }
    ]
  },
  "usr-local-linker": { "bin": ["bin/myapp-cli"], "lib": [], "etc": [] },
  "docker-project": { "projects": [ { "name": "myapp-stack", "path": "docker" } ] },
  "api-scope": ["trim.file.sharedAccess", "trim.system.getPlatformConfig"]
}
```

- `data-share`：安装自动创建 `/vol{n}/@appshare/<name>`，可经 `TRIM_DATA_SHARE_PATHS` 或 `/var/apps/{appname}/share/` 访问；`permission.rw/ro` 填用户名；使用 Windows ACL。
- `usr-local-linker`：分别链接到 `/usr/local/bin|lib|etc/`。
- `docker-project`：`path` 相对 `app/`，目录内须有 `docker-compose.yaml`，fnOS 托管 Compose 生命周期。
- `api-scope`：开放 API 权限列表，见第二部分。

## 七、应用入口与统一网关

| 模式 | 路径 | 适用 |
|------|------|------|
| 统一网关（推荐） | `/app/{appname}` 或 `/app/{appname}/{customPath}` | 常驻服务，复用 fnOS 登录态/HTTPS/域名；需 `os_min_version>=1.1.3100` |
| 直连端口 | `http://NAS:port/` | 临时/局域网；`ui/config` 填 `port` |
| index.cgi | `/cgi/ThirdParty/{appname}/index.cgi/` | 无常驻进程，不支持 WebSocket |

`app/ui/config`（入口 ID 用 `appname.xxx`）：

```json
{
  ".url": {
    "myapp.main": {
      "title": "My App",
      "icon": "images/icon_{0}.png",
      "type": "iframe",
      "protocol": "",
      "port": "",
      "gatewayPrefix": "/app/myapp",
      "gatewaySocket": "app.sock",
      "url": "/app/myapp",
      "allUsers": true,
      "noDisplay": false
    }
  }
}
```

- `type`：`iframe`（桌面窗口内）/ `url`（新标签页）
- `protocol`：`http` / `https` / 空（空=跟随当前页面）；走网关时留空
- `port`：直连端口模式填写；留空表示走网关
- `gatewayPrefix` / `gatewaySocket`：公开前缀与 `$TRIM_APPDEST` 下的 Unix socket 文件名；WebSocket 建议单独前缀 `/app/{appname}/ws`
- `url` 支持 `${wizard_xxx}` 引用向导变量
- `noDisplay: true` 隐藏桌面图标；`fileTypes` 注册文件打开方式；`control.accessPerm` 取 `editable|readonly|hidden`

网关转发时附带用户头：`X-Trim-Userid`、`X-Trim-Isadmin`、`X-Trim-Username`。直连端口模式没有这些头，不要把它们当成外网可信凭据。

## 八、向导（wizard/）

```json
[
  {
    "stepTitle": "配置",
    "items": [
      { "type": "text", "field": "wizard_port", "label": "服务端口", "initValue": "8080",
        "rules": [ { "required": true, "message": "请输入端口" }, { "pattern": "^[0-9]+$", "message": "仅限数字" } ] },
      { "type": "select", "field": "wizard_mode", "label": "模式",
        "options": [ { "label": "标准", "value": "std" }, { "label": "精简", "value": "lite" } ] }
    ]
  }
]
```

- 类型：`text` `password` `radio` `checkbox` `select` `switch` `tips`（只读提示，用 `helpText`）
- 校验：`required` `min`/`max` `len` `pattern`
- `radio`/`checkbox`/`select` 用 `options: [{label, value}]`
- `field` 即环境变量名；禁止 `TRIM_` 前缀

## 九、config/privilege

```json
{
  "defaults": { "run-as": "package" },
  "username": "myapp",
  "groupname": "myapp",
  "join-groups": ["docker"]
}
```

- `run-as: package` 以应用用户运行（推荐）；`root` 仅限特权准备任务，长期进程应 `runuser -u "$TRIM_USERNAME" -- <cmd>` 降权。
- `username`/`groupname` 可省略，默认按 appname 生成；`join-groups` 追加 `docker` `video` `render` 等组。
- privilege 只作用于宿主进程，对 Docker 容器内部无效。

## 十、图标规范

PNG 或 JPG，sRGB，正方形，单文件 ≤1024KB。提供 `ICON.PNG`（64）与 `ICON_256.PNG`（256）。

## 十一、依赖、运行时与中间件

```ini
install_dep_apps=database>2.2.2:cache
```

- `:` 分隔，`>` 最低版本；安装顺序从右到左；不递归解析嵌套依赖。
- 官方运行时包：`python312`、`nodejs_v22`、`nodejs_v24`、`java-21-openjdk`，PATH 在 `/var/apps/<pkg>/target/bin`。不要在脚本里 `apt install`。
- 官方中间件：`redis`(6379) `minio`(9000) `rabbitmq`(5672)。使用独立 db 编号/key 前缀/队列名。
- 应用自带的解释器/虚拟环境放 `$TRIM_PKGHOME`，升级不丢。

## 十二、开发与发布工具

| 工具 | 用途 | 用法 |
|------|------|------|
| `fnpack` | 骨架与打包 | 下载 `https://static2.fnnas.com/fnpack/fnpack-1.2.3-<os>-<arch>`（`windows-amd64` `linux-amd64` `linux-arm64` `darwin-amd64` `darwin-arm64`）；`fnpack create <app> [--template docker] [--without-ui true]`；`fnpack build [--directory <path>]` |
| `appcenter-cli`（NAS 本机） | 本地安装调试 | `appcenter-cli install-fpk x.fpk [--env config.env]`、`install-local <dir>`、`default-volume [N]`、`list` `start` `stop` |
| `fnos-cli`（远程） | 远程安装/启停 | `fnos-cli app install-fpk <file> --volume-id <id> [--dry-run] --yes`、`app start|stop|uninstall <app> --yes` |
| 上架 | 进入应用中心 | 通过官方“开发者先锋交流群”提交审核 |

fnpack 打包前自动校验：`manifest`、`config/privilege`、`config/resource` 存在且合法；`ICON.PNG`/`ICON_256.PNG` 存在；`app/` `cmd/` `wizard/` 存在；声明 `desktop_uidir` 时对应目录存在。

## 十三、端口规划（经验值，非官方规定）

系统占用：5666/5667（WEB UI）、22（SSH）、445（SMB）、2049（NFS）、5005/5006（WebDAV）、8000（飞牛影视）。第三方应用建议 18000–19999，并在 manifest `service_port` 声明。

---

# 第二部分：开放 API（api-scope）

> 要求 fnOS ≥ 1.2.0401、应用中心 ≥ 1.34.0。这是应用级 Token 机制，不是 OAuth。fnos-cli 的 OAuth 授权是另一套面向用户的流程。

## 接入三步

1. `manifest` 加 `micro_app=true`、`os_min_version=1.2.0401`。`config/resource` 声明 `"api-scope": [...]`。
2. 前端使用 `@trimjs/web-app` SDK（获取当前用户、主题、文件选择器等页面能力）。
3. 后端读取环境变量 `TRIM_API_TOKEN`，经 Unix socket 调用：

```bash
curl --unix-socket /var/run/trim_open_gateway_apiscope.socket \
  -H "Authorization: Bearer $TRIM_API_TOKEN" -H "Content-Type: application/json" \
  -X POST http://localhost/api/v1/trimapp \
  -d '{"reqId":"1","req":"trim.file.sharedAccess","appName":"myapp","data":{}}'
```

## 已公开 Scope

| Scope | 作用 |
|-------|------|
| `trim.file.sharedAccess` | 读取共享目录及访问权限 |
| `trim.file.userAccess` | 读取用户可访问目录 |
| `trim.file.userAcl` | 读取用户 ACL |
| `trim.file.path` | 路径解析 |
| `trim.system.getPlatformConfig` | 读取平台配置 |

## 错误码

- SDK：`1000000~1003201`，其中 `1000002` = 未声明对应 scope。
- 后端网关：`200003` Token 无效、`200004` scope 不足、`200005` 参数错误。

---

# 第三部分：WebSocket API 直连（备用）

> 仅当 fnos-cli 不可用（例如目标 fnOS < 1.2.0800 无法 OAuth 授权，或需要 fnos-cli 未封装的端点）时使用。接口来自逆向与社区验证，非官方承诺，可能随版本变化。fnos-cli 已覆盖的端点见 `skills/fnos/reference/`，此处不重复。

## 一、连接信息

```
WebSocket:  wss://<NAS_IP>:5667/websocket?type=main
HTTPS 上传: https://<NAS_IP>:5667/upload
```

- 必须用 NAS 真实内网 IP。`127.0.0.1:5667` 是 nginx 反代，登录会被静默丢弃（errno 131089）。
- 自签名证书，需关闭 SSL 校验。
- 管理类端点（`stor.*`、`appcgi.resmon.*`、Docker、应用中心、用户管理）需管理员账号，普通用户返回 errno 4352。`user.login` 响应的 `admin` 字段可判断。

## 二、认证流程（4 步）

```python
import os, json, ssl, base64, random, websockets
from Crypto.PublicKey import RSA
from Crypto.Cipher import PKCS1_v1_5, AES
from Crypto.Util.Padding import pad, unpad

ssl_ctx = ssl.create_default_context(); ssl_ctx.check_hostname = False; ssl_ctx.verify_mode = ssl.CERT_NONE
ws = await websockets.connect('wss://<NAS_IP>:5667/websocket?type=main', ssl=ssl_ctx)

# 1. 取 RSA 公钥
await ws.send(json.dumps({'req': 'util.crypto.getRSAPub', 'reqid': '<reqid>'}))
resp = json.loads(await ws.recv()); pub, si = resp['pub'], resp['si']

# 2. RSA 加密随机 AES key，AES-CBC 加密登录 JSON
key = ''.join(random.choice('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ') for _ in range(32))
iv = os.urandom(16)
rsa_encrypted = base64.b64encode(PKCS1_v1_5.new(RSA.import_key(pub)).encrypt(key.encode())).decode()
login_json = json.dumps({"req": "user.login", "reqid": "<reqid>", "user": USER, "password": PASSWORD,
                         "deviceType": "Browser", "deviceName": "hermes", "stay": False, "si": si},
                        separators=(',', ':'))
aes_encrypted = base64.b64encode(AES.new(key.encode(), AES.MODE_CBC, iv)
                                 .encrypt(pad(login_json.encode(), AES.block_size))).decode()
await ws.send(json.dumps({'req': 'encrypted', 'iv': base64.b64encode(iv).decode(),
                          'rsa': rsa_encrypted, 'aes': aes_encrypted}, separators=(',', ':')))
login = json.loads(await ws.recv())

# 3. 保存 token / secret / backId / uid / admin
token, secret, backId = login['token'], login['secret'], login['backId']

# 4. 用同一 key/iv 解密 secret，得到 HMAC 密钥字节
secret_bytes = base64.b64decode(base64.b64encode(
    unpad(AES.new(key.encode(), AES.MODE_CBC, iv).decrypt(base64.b64decode(secret)), AES.block_size)))
```

## 三、请求签名

登录后除 `encrypted`、`util.getSI`、`util.crypto.getRSAPub` 外，所有请求都要 HMAC-SHA256 签名：

```python
import hmac, hashlib, time
_index = 1
def get_reqid(backId):                       # {timestamp_hex8}{backId16}{index_hex4}
    global _index
    r = format(int(time.time()), 'x').zfill(8) + backId + format(_index, 'x').zfill(4)
    _index += 1
    return r

def sign(data: dict, secret_bytes: bytes, backId: str) -> str:
    data = {**data, 'reqid': get_reqid(backId)}
    json_str = json.dumps(data, separators=(',', ':'))
    sig = base64.b64encode(hmac.new(secret_bytes, json_str.encode(), hashlib.sha256).digest()).decode()
    return sig + json_str                    # 发送：签名 + JSON 直接拼接
```

要点：`timestamp` 整数秒；`json.dumps` 必须 `separators=(',', ':')`；HMAC key 是解密后的 `secret_bytes`。心跳每 60 秒发 `{"req":"ping"}`，服务端不回复。

## 四、HTTPS 上传

先调 `file.checkUpload` 拿 `uploadName`，再：

```python
trim_path = f"{folder}/{upload_name}"
sig = base64.b64encode(hmac.new(secret_bytes, trim_path.encode(), hashlib.sha256).digest()).decode()
requests.post('https://<NAS_IP>:5667/upload', verify=False,
    headers={'Trim-Token': token, 'Trim-Path': trim_path, 'Trim-Sign': sig,
             'Trim-Overwrite': '2', 'Trim-Mtim': str(int(os.path.getmtime(local_path)))},
    files={"trim-upload-file": (filename, open(local_path, 'rb'), "application/octet-stream")})
```

路径格式 `vol{stor_id}/{uid}/{子路径}`，uid 来自 `user.info` → `userInfo.uid`。

## 五、常见 errno

| errno | 说明 | errno | 说明 |
|-------|------|-------|------|
| 4096 | 系统内部错误 | 131072 | 用户名或密码错误 |
| 4099 | 磁盘空间不足 | 131073 / 131074 | 用户名不存在 / 已存在 |
| 4100 | 文件或目录不存在 | 131089 | 登录请求被丢弃（多为连了 127.0.0.1） |
| 4101 | 无效文件名或路径 | 135168 | 无效的凭证 |
| 4102 | 文件或目录已存在 | 196608 / 196609 | 磁盘繁忙 / 磁盘数量不足 |
| 4103 | 存储空间不存在或未挂载 | 196624 | 存储池状态不允许该操作 |
| 4121 | 文件系统只读 | 327685 | 目标目录是源目录的子目录 |
| 4224 | 未登录 | 2031620 | 已是最新版本 |
| 4352 | 权限不足（非管理员） | 33554944 / 33554945 | 端口被占用 / 系统预留端口 |
| 4353 | Token 失效，重新登录 | 52428823 | 容器连接失败 |
| 8192 | 参数错误 | 100000001 | 操作太频繁 |
| 65534 | 验签失败（检查 separators / reqid / secret） | 100000003 | 重复的请求 |

## 六、fnos-cli 未覆盖的端点

> 文件（含 `file.rm` / `file.mv` / `file.trash.*` / 收藏 / 最近）、存储、监控、应用中心、Docker、下载、日志、用户、SSH 开关、时间/风扇/电源计划、照片、百度网盘已被 fnos-cli 封装，直接用 CLI。以下端点截至 2026-11-10 仍未封装：

| 端点 | 说明 |
|------|------|
| `user.tokenLogin`、`user.kickLoginDevice` | Token 续登、踢出登录设备 |
| `appcgi.network.net.list|info|state|set|add|del`、`appcgi.network.hostname` | 网卡配置、主机名 |
| `appcgi.netsvr.ddns.record.*`、`appcgi.netsvr.conn.*`、`appcgi.netsvr.cert.*` | DDNS、外网连接、证书 |
| `appcgi.share.smb|webdav|ftp|nfs|dlna.*` | 共享服务开关（需管理员） |
| `appcgi.backup.*`、`appcgi.mountmgr.*` | 备份任务、远程挂载 |
| `notify.list` / `unreadTotal` / `setRead` / `del` | 系统通知 |
| `liveupdate.check` / `status` / `update` | 系统在线更新 |

关于删除：`fnos-cli file rm` 对应 `file.rm`，**是永久删除**。要进回收站须 `fnos-cli file mv <src> /vol<N>/<uid>/.@#local/trash/ --yes`（可能因 ACL 失败）或引导用户在 WEB UI 删除。`file.rm` 的 `moveToTrashbin: true` 曾实测仍为永久删除。决策树见 `hermes-workflows` 第八节。
