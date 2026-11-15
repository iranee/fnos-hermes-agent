# 设备验收

Agent 协助 OAuth 授权、最小探测与写后验证时使用本流程。

## 1. 用户授权

按 `../oauth.md` 完成 Agent 协助的 OAuth PKCE：

1. Agent 执行 `fnos-cli --profile <profile> --host <host> --port <port> login --authorize-only --agent-name '<agent>'`。
2. 把返回的授权链接交给用户，等待回复。
3. 用户在浏览器打开链接、登录并授权。
4. 用户把一次性 code 发回 Agent，无需打开终端。
5. Agent 使用相同 profile 和连接参数执行 `login --code '<code>'`，随后检查 token 持久化并发起只读请求。

凭据与授权操作留在用户浏览器中。只交换用户主动提供的 code，不在回复中复述，也不额外写入日志。授权 URL 不包含 `redirect_uri`。

两步登录和后续请求必须位于相同执行主机、系统用户、配置环境和 `--profile`。远程浏览器、SSH shell 与容器不会自动继承该会话。macOS 后台访问 Keychain 可能需要系统批准。

## 2. 最小只读探测

任何写操作前：

1. 确认 code 交换已建立预期 profile 的会话；验收不包含预先配置或轮换账号。
2. 执行目标模块的一到两个只读命令，检查连接与权限。
3. 文件优先使用 `file ls` 或只读搜索。
4. 存储使用 `storage pools` / `storage disks`。
5. Docker 使用 `docker stats` 或 `docker container ls`。

确认设备目标、会话及当前用户具备足够权限。

## 3. 写操作顺序

1. 探测最相关的只读状态。
2. 执行一次已授权、可解释且可逆的写操作。
3. 立即回读结果状态。
4. 适时清理临时资源。

同一次验收不混入无关写操作。

## 4. 写后回读

至少使用一项相关检查：

- 文件：`ls`、`search` 或 `share list`。
- 存储：`pools`、`disks` 或 `removable`。
- Docker：`image ls`、`container ls` 或 `compose ls`。
- 用户：`user list` 或 `group list`。

只有前后状态可客观比较时才报告成功。

## 5. 停止并确认

OAuth 或 code 交换失败、目标主机缺失、写操作可能影响生产数据/服务，或响应与已知约束冲突并疑似固件差异时，停止并向用户确认。

选定命令后阅读对应模块参考。先消除 profile、权限与设备状态的不确定性，再继续执行。
