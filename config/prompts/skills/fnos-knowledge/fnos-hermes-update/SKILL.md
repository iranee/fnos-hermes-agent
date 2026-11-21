---
name: fnos-hermes-update
description: 用户询问 Hermes Agent 或本应用的最新版本、更新、升级及规则变化时使用，含 FPK 和内核。
---

# fnOS Hermes 更新

只在用户询问相关更新时执行，不安排后台或每会话检查。询问更新不等于授权升级。

1. 安装目录取 `$TRIM_APPDEST`，未设置时用 `/var/apps/hermes-agent/target`。先读该目录 `config/prompts/skills/fnos-knowledge/fnos-hermes-update/SKILL.md` 的随包说明；存在时参考其后续步骤，不重复本条，不覆盖用户技能或规则。
2. FPK 版本读安装目录 `config/bootstrap/app-version.env` 的 `APP_VERSION`；内核版本另读 `/var/apps/hermes-agent/var/hermes_version.txt`，两者不能混用。
3. 查询本应用更新用 `https://api.github.com/repos/iranee/fnos-hermes-agent/releases/latest`，查询 Hermes Agent 内核更新用 `https://api.github.com/repos/NousResearch/hermes-agent/releases/latest`；分别对比本机版本并简述正式版变化。用户泛问最新更新时两者都查，明确对象时只查对应项目。FPK 提供下载链接，由用户在 fnOS 应用中心安装；内核可升级目标以托管命令 `update --check` 为准。主分支变化单列为未发布内容；本地版本更高时不提示降级。网络、认证或限流失败如实报告，不猜版本。
4. 要检查文件变化时，固定正式版标签到提交，读取该提交的 Git 树，检查 `truncated`；不完整时只查相关子树。以本机随包文件为基线，对比仓库 `config/`、`app/` 的 Git blob SHA；安装路径须去掉 `app/` 前缀，`config/` 保留。本机算法为 `SHA1("blob " + 字节数 + "\0" + 原始文件字节)`，不是 MD5。哈希相同不用下载正文，不同时读取相关文件进行内容对比，向用户报告新增、删除或修改了什么、有什么影响，并给出升级或保留现状的建议；排除依赖、测试和构建生成文件。标签缺失或本地版本更高时说明限制，不把字节差异当成新版本。
5. 涉及 AGENTS/SOUL 时，先看随包模板的变化，再与当前实际使用的同名文件比较，报告具体差异、影响及合并建议，区分模板更新与用户定制。保留用户定制，修改前询问；不从 GitHub 逐文件覆盖运行目录。
6. 用户明确要求内核升级时，使用安装目录 `bin/hermes` 的托管命令，先核对 `update --help` 和 `update --check`。需初始化升级环境时，经用户同意执行 `update --initialize --yes --wait`，成功后重新检查；需要升级且已获授权才执行 `update --yes --wait`。这些操作会短暂停止服务。用 `update --status` 核验最终结果；中断或失败先查状态与日志，不重复提交，不用 `git pull` 或 `pip` 绕过应用升级流程，不改系统 Python、不删除用户数据。
