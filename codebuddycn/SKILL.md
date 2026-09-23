---
name: codebuddycn
description: Install, configure, and call CodeBuddy Chinese Site models through Tencent's official Agent SDK and local CLI. Use for this CodeBuddy CN integration, authorized Cockpit or WorkBuddy account import, account selection, and persisted conversation resume. Works from local agent harnesses such as Kimi Code, Codex, and Claude Code. Do not use the CodeBuddy CN IDE launcher as the backend.
---

# CodeBuddy CN — 通用 Skill

通过官方 `@tencent-ai/agent-sdk` 控制本机 CodeBuddy Code CLI，调用使用者自己的中国站账号模型。适用于能够读取 Skill 文件并执行本地 Node.js 命令的 agent harness。它不会把订阅额度转换成通用 HTTP API。

## 安装与初始化

用户说“安装这个 Skill”时，由智能体完成以下流程，不要求用户复制长指令或逐条执行命令。该请求包括本 Skill、SDK 和缺失的独立 CLI 的安装；复用现有可用依赖，不自行升级或覆盖用户配置。仅审查仓库时不执行安装。

1. **识别环境。** 确认当前宿主、操作系统、shell，以及 Node.js `22.13+` 和 npm。优先使用已安装的合适运行时；缺少时按 [Node.js 官方方式](https://nodejs.org/en/download)和本机权限安装受支持的 LTS 版本。Windows 使用 PowerShell/CMD 对应语法，不照搬 Bash 的 `env`、`chmod` 或续行符。
2. **安装完整目录。** 从 [本仓库](https://github.com/c2bjjn6xg7-collab/codebuddycn)获取内层 `codebuddycn/`，将整个目录复制到当前宿主的用户级位置。已有同名 Skill 时先比较，复用相同版本、保留本地修改；避免复制成 `codebuddycn/codebuddycn`。

   | 宿主 | 用户级 Skill 目录 |
   |---|---|
   | Codex / 当前 Kimi Code | `~/.agents/skills/codebuddycn/` |
   | Claude Code | `~/.claude/skills/codebuddycn/` |

   `~` 表示实际用户主目录；Windows 对应 `%USERPROFILE%`，PowerShell 中可用 `$env:USERPROFILE`。宿主已指定自定义 Skill 目录时沿用其设置；旧版 Kimi 按实际发现目录安装。Codex 和 Kimi 可共用一份目录，同一宿主不要在多个发现目录安装不同版本的同名 Skill。安装的是本 Skill，不是更改 CodeBuddy 自己的配置目录。完成复制后，以下 `{baseDir}` 均指**安装后的目录**。
3. **安装依赖和 CLI。** 在 `{baseDir}` 执行 `npm ci --omit=dev`。检查 `codebuddy --version`；已有可用独立 CLI 就复用，缺少时按 [官方安装说明](https://www.codebuddy.cn/docs/cli/installation)安装，npm 方式为 `npm install -g @tencent-ai/codebuddy-code`。不要把 `buddycn` IDE 启动器当成 CLI。
4. **匹配启动方式。** Windows 的官方 npm `.cmd` 入口由脚本自动解析到包内 Node 入口，原生 `.exe` 直接启动；不需要 macOS/Linux 的原生适配器。macOS/Linux 检查 `codebuddy` 的实际路径和文件类型，原生二进制按下文“原生 CLI 适配”设置。将这些操作和实际路径由智能体完成，不把示例路径交给用户填写。
5. **完成本地检查。** 在 `{baseDir}` 执行 `node scripts/preflight.mjs --json` 和 `node scripts/codebuddycn-run.mjs --dry-run --prompt "本地参数检查" --format json`；需要原生适配时，两条命令都带下文的环境变量。检查失败就处理明确的依赖或路径问题后重跑；这两项不会发送模型请求，也不证明已登录或模型可用。
6. **交付可用入口。** 简短报告安装位置和检查结果。首次登录由使用者在交互终端运行 `codebuddy`、输入 `/login` 并选择 **Chinese Site**；已有登录态不要求重新登录。Codex 使用 `$codebuddycn`，Kimi 使用 `/skill:codebuddycn`，Claude Code 使用 `/codebuddycn`。宿主未发现新 Skill 时再新开会话或重启。安装期间不要求选择模型、不导入账户、不发送真实模型请求。

### 原生 CLI 适配（仅 macOS/Linux）

本包固定的 SDK `0.3.256` 通过 Node 启动 CLI，macOS/Linux 原生二进制需要随包的 `scripts/native-transport.mjs`。确认实际 CLI 路径后执行：

```bash
chmod u+x "{baseDir}/scripts/native-transport.mjs"
env CODEBUDDYCN_NATIVE_BIN="/verified/native/codebuddy" \
  CODEBUDDYCN_BIN="{baseDir}/scripts/native-transport.mjs" \
  node "{baseDir}/scripts/preflight.mjs" --json
```

由智能体替换两个路径；**每次** dry-run 和模型调用也保留这两个变量。JS CLI 和 Windows `.exe` 不套用此适配。它仍使用 SDK 后端，不改写全局启动器或登录配置。详情见 [references/headless-development.md](references/headless-development.md)。

Windows 已包含 npm/原生 CLI 启动、用户目录和 DPAPI 凭据支持；离线模拟测试不等于 Windows 实机登录和端到端调用验证。

## 路径与后端

- 本文及参考文档的 `{baseDir}` 表示**当前加载的这个 `SKILL.md` 所在目录**。先解析成实际绝对路径，再替换命令中的占位符；不得把字面量 `{baseDir}` 传给 shell，也不要用项目 cwd 代替。
- Kimi Code 可从其注入的 `${KIMI_SKILL_DIR}` 确定目录；Claude Code 可从 `${CLAUDE_SKILL_DIR}` 确定；其他宿主使用 Skill 列表提供的文件位置。未被宿主展开的占位符不是已存在的 shell 环境变量。
- `scripts/`、`references/`、`package.json` 和安装后的 `node_modules/` 全部相对于 `{baseDir}`。包内不依赖外部 `shared` 符号链接，也不要求另一个 harness 已安装。
- `agents/openai.yaml` 仅供 Codex 的界面读取，其他宿主可忽略。
- 独立无头 CLI 叫 `codebuddy` / `cbc`，npm 包名为 `@tencent-ai/codebuddy-code`，登录时选择 **Chinese Site**。`buddycn chat` 是 IDE 启动器，不能替代它。
- 默认后端 `--backend sdk`；只有用户明确选择兼容回退时才用 `--backend cli`。失败后不自动改用另一后端、账户或模型重放同一请求。

## 先确定账户和模型

分享版没有预设账户、个人模型偏好或固定的价格/可用性清单。用户在当前任务中已经明确给出的选择直接沿用，不重复询问。

**账户：** 用户明确选择“当前 CodeBuddy CLI 登录账户”时，省略 `--account`。用户选择已导入账户时，使用其确认的 `cbXX` 别名或唯一实际名称。尚未确定时，可只读列出本地账户，再询问使用哪个账户或当前 CLI 登录态：

```bash
node "{baseDir}/scripts/codebuddycn-accounts.mjs" list
```

账户名称可能包含手机号或邮箱；只向当前使用者按其显示偏好展示，不把列表放进公开输出、分享包或模型 prompt。名称重复时使用别名。`cb01`、`cb02` 等文档示例只是各使用者导入后分配的别名，不代表包中自带账户。

**模型：** 使用用户指定的模型 ID，或用户已经授权的本地路由规则；只有用户明确选择“当前默认模型”时才省略 `--model`。如果两者都未确定，将缺失的账户、模型合并为一个简短问题。不得继承分享者的偏好，也不要把示例 `MODEL_ID` 当成真实 ID。

只有明确选择自动轮询时才可用 `--account auto`；它每次只选择一个账户，不是额度耗尽后自动换号。`--continue` / `--resume` 不能配合 `auto`。

加载 Skill、安装依赖、列出账户、`--dry-run` 和 preflight 均不等于授权发送模型请求。此类准备任务不需要先选择模型账户；实际调用前才需完成上述选择。

## 环境准备与调用

1. 运行环境检查：

   ```bash
   node "{baseDir}/scripts/preflight.mjs"
   ```

   它只检查 CLI 版本、参数和 SDK 导入，并查看账户元数据的数量，不读取凭据值或发送模型请求。预检通过不证明登录有效、模型可用或 SDK 已成功握手。

2. 缺少依赖时按上文“安装与初始化”处理。用户已经要求安装本 Skill 时，不为同一范围的依赖安装重复询问；其他情况下先取得安装授权。不自行升级 SDK/CLI、重新登录或修改全局配置。

3. macOS/Linux 原生 CLI 按上文“原生 CLI 适配”配置，并在 preflight 和后续每次调用中保留两个环境变量；Windows 的 npm 入口自动处理，原生 `.exe` 直接使用。

4. 进行已授权的一次性问答。以下示例假设用户选择了当前 CLI 登录账户和具体模型；若使用导入账户，增加 `--account APPROVED_ALIAS`；原生 CLI 同时保留上一步的两个环境变量：

   ```bash
   node "{baseDir}/scripts/codebuddycn-run.mjs" \
     --model MODEL_ID --prompt "给这个设计提三个风险点" --format json
   ```

   默认禁用所有项目/外部工具，只加载用户级设置，限制一个 agent turn，且不保存会话。`--json-schema-file` 只额外启用内置、非变更型 `StructuredOutput`。可通过 `--input-file` 传入用户已选定的文本，或用 `--prompt-file` 读取任务说明，不必开放文件工具。

5. 检查退出码、最终 result 和实际回答。JSON 成功结果的 `backend` 应为 `sdk`、`via` 为 `codebuddy-agent-sdk-chinese-site`，答案在 `response.text`，会话 ID 在 `session.id`。空输出或缺少最终结果不能宣称成功。`authentication_required` 交由用户完成登录；模型拒绝按原错误报告，再核实使用者当前选择器中的 ID，不静默替换。

需要无请求验证时可用：

```bash
node "{baseDir}/scripts/codebuddycn-run.mjs" --dry-run --prompt "本地参数检查" --format json
```

该命令不解密账户、不请求模型，但输出可能包含本机路径，分享诊断时仍需检查。SDK 参数映射和输出格式见 [references/sdk.md](references/sdk.md)。

## 可选的多账户管理

只有用户明确授权处理其凭据并指定 Cockpit/WorkBuddy 导出文件时才导入。不要主动搜索他人导出或读取 IDE、数据库、Keychain、日志中的凭据。

```bash
node "{baseDir}/scripts/codebuddycn-accounts.mjs" import-cockpit /absolute/authorized-export.json
node "{baseDir}/scripts/codebuddycn-accounts.mjs" list
node "{baseDir}/scripts/codebuddycn-accounts.mjs" verify cb01
```

导入器收紧源文件权限；凭据保存到 macOS Keychain、Windows DPAPI 或 Linux Secret Service，不使用明文回退。私人索引保存别名、实际名称和计数，位于操作系统用户数据目录中，不在 Skill 目录中。共享不同 harness 的 Skill 副本不会附带或复制这些凭据。

选择导入账户时，仅通过 SDK 子进程环境注入身份，不覆盖 CodeBuddy 全局登录态。禁止把 Token 写进 shell 参数、prompt、输出或调试日志。详情见 [references/cli.md](references/cli.md)。

## 持久会话与跨账户恢复

多轮任务从第一轮使用 `--persistent`。`--format stream-json` 用于查看进度，JSONL 中从 init/result 的 `session_id` 记录会话；`--format json` 的字段是 `session.id`。同账户续跑用已记录的 `--resume SESSION_ID`，保留账户、模型、cwd、工具和权限参数。

只有用户明确提出跨账户恢复时，先完整读取 [references/cross-account-resume.md](references/cross-account-resume.md)：

- 来源会话须已持久化；确定来源别名、目标别名、会话 ID 和模型，不用 `auto`。
- 停止可能同时写同一会话存储的 CodeBuddy IDE/CLI。迁移会暂时修改本机会话索引和数据库。
- 使用 `--resume SESSION_ID --resume-from-account SOURCE_ALIAS --account TARGET_ALIAS --format json`，封装器强制 fork 并恢复来源归属。
- 存在 `session.warning`、缺失新 fork ID 或恢复失败时，报告警告和备份位置并停止；不要自动重试。
- 请求中断时可能已执行工具或消耗额度，跨号重放同一 prompt 必须经用户明确确认。

## 允许 CodeBuddy 操作项目时

只有用户明确要求 CodeBuddy 读取、执行或修改指定项目，才开放相应工具。使用最小 `--tools` 白名单，按需设置 `--allowed-tool`；`--add-dir` 只加入任务涉及目录。工具许可不是文件系统隔离，尤其 Bash 可以访问其他路径。

```bash
node "{baseDir}/scripts/codebuddycn-run.mjs" \
  --account APPROVED_ALIAS --model MODEL_ID \
  --cwd /absolute/authorized-project \
  --tools "Read,Glob,Grep,Edit,Write,Bash" \
  --allowed-tool Read --allowed-tool Glob --allowed-tool Grep \
  --allowed-tool Edit --allowed-tool Write --allowed-tool Bash \
  --permission-mode acceptEdits \
  --persistent --format stream-json --max-turns 20 --timeout 1200 \
  --prompt-file /absolute/task.md
```

按实际授权缩小目录和工具范围；此示例不构成新增授权。不要默认 `--tools default`、`--skip-permissions` 或 `bypassPermissions`，不要通过参数绕过宿主审批或真实拒绝。封装器不会自动设置 `CODEBUDDY_IS_SANDBOX=1`；只有确实位于隔离沙箱且用户明确授权完全放行时才考虑该变量。

完成后由调用者检查实际 diff、产物和适当测试，不能只复述模型的成功声明。若长任务中断，先确认原进程结束并检查已有改动，再在原授权范围内续做剩余工作，避免重放。权限、原生传输及长任务排错见 [references/headless-development.md](references/headless-development.md)。

## 维护与再次分享

- SDK 依赖版本由随包 lockfile 固定。升级前运行模拟测试和只读导入检查；真实模型测试需有相应账户、模型与任务授权。
- 不自动切换 API key；若用户明确选择中国站 API key，再按官方文档设置 `CODEBUDDY_API_KEY` 与 `CODEBUDDY_INTERNET_ENVIRONMENT=internal`，不显示其值。
- 只分享 Skill 文本和源代码，不附带账号导出、私人索引、系统凭据、会话/备份、日志、个人配置、缓存、`node_modules` 或指向这些目录的链接。
