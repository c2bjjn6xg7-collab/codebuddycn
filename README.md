# CodeBuddy CN Skill 分享包

这是一份自包含的本地 Agent Skill：Kimi Code、Codex、Claude Code 使用同一份 `codebuddycn/`，通过腾讯官方 Agent SDK 调用使用者自己的 CodeBuddy 中国站账号。它保留一次性问答、可选多账户管理、持久会话和跨账户恢复功能。

包中没有附带账号、Token、手机号/邮箱名册、真实会话、个人模型偏好、机器绝对路径或外部符号链接。示例中的 `cb01` / `cb02` 是占位别名，测试里的账户与会话是虚构数据。

从 GitHub 页面选择 **Code → Download ZIP** 下载，或使用 Git：

```bash
git clone https://github.com/c2bjjn6xg7-collab/codebuddycn.git codebuddycn-share
cd codebuddycn-share
```

下载后的仓库包含安装说明和 `codebuddycn/` Skill 文件夹。下面需要复制的是这个内层文件夹。

## 1. 安装到宿主

把完整的 `codebuddycn` 文件夹复制到对应位置，不要只复制 `SKILL.md`。安装后重新启动宿主会话。目标已有同名 Skill 时先比较或备份，再由使用者决定如何更新，避免复制成 `codebuddycn/codebuddycn`。

| Harness | 用户级目录 | 手动使用 |
|---|---|---|
| Codex | `~/.agents/skills/codebuddycn/` | `$codebuddycn` |
| Kimi Code | `~/.agents/skills/codebuddycn/` | `/skill:codebuddycn` |
| Claude Code | `~/.claude/skills/codebuddycn/` | `/codebuddycn` |

安装目录按官方说明核对：[Codex](https://learn.chatgpt.com/docs/build-skills)、[Kimi Code](https://moonshotai.github.io/kimi-code/en/customization/skills.html)、[Claude Code](https://code.claude.com/docs/en/skills)。较旧 Python 版 Kimi CLI 的目录优先级不同，见[旧版说明](https://moonshotai.github.io/kimi-cli/en/customization/skills.html)；未发现时按实际版本配置目录。

同时使用 Codex 和 Kimi Code 可共用 `~/.agents/skills/codebuddycn/`。Claude Code 可单独复制；macOS/Linux 也可让其 `~/.claude/skills/codebuddycn` 指向这份本机目录，以共用依赖。符号链接由接收者在自己的机器创建，分享包本身没有链接。不要在同一宿主的多个发现目录放不同版本的同名 Skill。

其他 harness 若支持 `SKILL.md` 和本地终端执行，也可放入其 Skill 目录；未做逐个宿主实测。仅能聊天、不能运行本地 CLI 的环境无法直接使用此集成。

## 2. 安装 SDK 与 CodeBuddy CLI

基础脚本要求 Node.js `18.20+`，完整测试建议使用支持 `node:sqlite` 的 Node.js `22.13+`。在安装后的 **codebuddycn 目录**执行：

```bash
npm ci --omit=dev
node scripts/preflight.mjs
```

本包使用 `@tencent-ai/agent-sdk@0.3.256`。`node_modules` 不随包分享，由接收者安装。SDK 仍需要独立的 CodeBuddy Code CLI。按[官方安装说明](https://www.codebuddy.cn/docs/cli/installation)安装；已有 CLI 的机器无需重装。npm 方式为：

```bash
npm install -g @tencent-ai/codebuddy-code
codebuddy --version
```

首次由使用者在交互终端运行 `codebuddy`，输入 `/login` 并选择 **Chinese Site**，完成自己的登录。这里不需要向分享者提供账号或 Token，也不强制导入任何账户导出文件。IDE 的 `buddycn chat` 不能替代独立 CLI。

macOS/Linux 如果安装的是原生 CLI，本包 SDK 需要传输适配。请在 `codebuddycn` 目录检查 `command -v codebuddy` / `file` 得到的本机路径，再执行（两个路径先替换）：

```bash
chmod u+x scripts/native-transport.mjs
env CODEBUDDYCN_NATIVE_BIN="/your/actual/codebuddy" \
  CODEBUDDYCN_BIN="/your/installed/codebuddycn/scripts/native-transport.mjs" \
  node scripts/preflight.mjs
```

模型调用也要带这两个变量；Skill 已包含这条指令。具体背景见 [原生 CLI 适配](codebuddycn/references/headless-development.md)。无需修改全局登录或把 Token 写进环境配置示例。

## 3. 开始使用

在宿主里明确选择账号方式与模型，例如：

> 用 codebuddycn，通过我当前 CodeBuddy CLI 登录账户和当前默认模型，审查下面的方案。只给建议，不开放项目操作工具。

也可以指定具体模型 ID。分享版不带固定模型路由，模型可用性与额度由使用者自己的账号决定。

需要多账户功能时，由使用者明确授权处理自己的 Cockpit/WorkBuddy 导出文件。凭据进入操作系统凭据服务；不导入也可以沿用 CLI 登录态。多账户依赖为 macOS Keychain 和编译 helper 所需的 clang、Windows DPAPI，或 Linux `secret-tool` 与可用的 Secret Service；没有明文存储回退。

跨账户恢复会修改本地会话存储，必须按 [恢复说明](codebuddycn/references/cross-account-resume.md)执行。它不是服务端官方跨号迁移保证，不能靠复制整个私人数据目录来分享 Skill。

## 4. 本地检查与验证范围

在 Skill 目录执行以下命令，不会发送真实模型请求：

```bash
node scripts/codebuddycn-run.mjs --dry-run --prompt "检查参数" --format json
npm test
```

测试使用虚构 SDK/CLI 和临时会话数据。`npm test` 的会话测试直接使用 `node:sqlite`，因此需要 Node.js `22.13+`。跨账户恢复运行时也可使用系统 `sqlite3` 作为后备。

本次交付验证覆盖格式、路径、离线模拟与本机预检；没有在三个宿主中分别发送付费模型请求，也没有验证 Windows/Linux 的真实认证流程。接收者完成自己的登录后才能确认其账户、模型和 CLI 版本的实际可用性。

## 5. 分享内容

`codebuddycn/` 中包含 Skill、脚本/测试、参考资料、Codex 可选 UI 元数据和 npm 依赖描述。后续再次打包时只携带这些源文件。

不要加入账号导出、`accounts-v1.json`、`.env`、系统凭据、CodeBuddy 数据目录、会话数据库/备份、任务日志、个人宿主配置、`node_modules` 或缓存。本包 `.gitignore` 只是常用排除提示，压缩文件仍需检查实际内容。
