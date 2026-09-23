# CodeBuddy CN Skill

让 Kimi Code、Codex、Claude Code 等本地智能体，通过腾讯官方 Agent SDK 和独立 CLI 调用你自己的 CodeBuddy 中国站账号。支持问答、可选多账户管理、持久会话和跨账户恢复。

## 让智能体安装

把这句话发给你的智能体即可：

> 帮我安装这个 Skill：https://github.com/c2bjjn6xg7-collab/codebuddycn ，按仓库里的说明完成配置。

**给执行安装的智能体：** 请读取 [codebuddycn/SKILL.md 的“安装与初始化”](codebuddycn/SKILL.md#安装与初始化)，完成环境识别、完整目录安装、依赖安装、CLI 适配和自检。Skill 位于仓库内层 `codebuddycn/`，不要只下载 `SKILL.md` 或把仓库根目录当作 Skill。首次账号登录由使用者完成。

安装步骤统一维护在 Skill 中；不需要使用者手动填写本机路径。手动下载也可用 GitHub 的 **Code → Download ZIP**，再让智能体读取其中的 `codebuddycn/SKILL.md`。

## 环境与支持范围

- 要求 **Node.js 22.13+**、npm，以及能够执行本地命令的智能体。仅聊天、不能运行本地 CLI 的环境无法直接使用。
- SDK 固定为 `@tencent-ai/agent-sdk@0.3.256`，安装时下载依赖；独立 CodeBuddy Code CLI 仍需安装，`buddycn` IDE 启动器不能替代它。
- 包含 macOS、Windows、Linux 适配。Windows 的官方 npm `.cmd` 启动器会自动解析到包内 Node 入口，原生 `.exe` 可直接使用；macOS/Linux 原生 CLI 的适配由智能体按 Skill 完成。
- 验证覆盖本机预检和离线模拟；**尚未完成 Windows/Linux 的真实登录及端到端调用验证**。自检通过不等于账户、模型或额度可用。

用户级目录与调用方式见 [Skill](codebuddycn/SKILL.md#安装与初始化)，依据 [Codex](https://learn.chatgpt.com/docs/build-skills)、[Kimi Code](https://moonshotai.github.io/kimi-code/en/customization/skills.html)、[Claude Code](https://code.claude.com/docs/en/skills) 官方说明；[旧版 Kimi](https://moonshotai.github.io/kimi-cli/en/customization/skills.html) 按实际发现目录处理。

## 开始使用

安装并完成自己的 CodeBuddy 登录后，对智能体说：

> 用 codebuddycn，通过我当前 CodeBuddy CLI 登录账户和当前默认模型，审查下面的方案。只给建议，不开放项目操作工具。

也可指定具体模型 ID。模型可用性和额度由你自己的账号决定，分享版不带固定模型路由。

多账户是可选功能，需要使用者授权导入自己的 Cockpit/WorkBuddy 导出文件；不导入也可以使用 CLI 登录态。凭据保存到 macOS Keychain、Windows DPAPI 或 Linux Secret Service，没有明文回退。详见 [账户说明](codebuddycn/references/cli.md)。

[跨账户恢复](codebuddycn/references/cross-account-resume.md)会修改本地会话存储；它不是官方服务端跨号迁移保证。

## 本地测试与分享

在安装后的 `codebuddycn/` 目录执行 `npm test`，测试使用虚构 SDK/CLI、账户和临时会话数据，不发送真实模型请求。环境检查及 dry-run 命令见 [Skill 安装步骤](codebuddycn/SKILL.md#安装与初始化)。

包中不附带账号、Token、手机号/邮箱名册、真实会话、个人模型偏好、个人机器路径或外部符号链接。`cb01` / `cb02` 是占位别名，测试中的账户与会话是虚构数据。

再次分享时只携带 Skill 文本、脚本/测试、参考资料、UI 元数据和 npm 依赖描述。不要加入账号导出、`accounts-v1.json`、`.env`、系统凭据、CodeBuddy 数据目录、会话数据库/备份、任务日志、个人宿主配置、`node_modules` 或缓存。`.gitignore` 只是排除提示，压缩包仍需检查实际内容。
