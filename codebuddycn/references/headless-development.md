# 无头开发：原生传输、权限与续跑

用于已获用户授权的 CodeBuddy 项目操作。这里描述本包固定 SDK `0.3.256` 的兼容处理，升级后应重新检查本机代码，不将版本问题当成永久限制。

## 原生 CLI 传输

SDK 的 `lib/transport/process-transport.js` 会通过 Node 启动 CLI，并可能把结尾为 `bin/codebuddy` 的路径改写成 `dist/codebuddy-headless.js`。这不适用于 macOS/Linux 原生二进制。预检读取版本/help 和导入 SDK 成功，仍可能在真正初始化 SDK 时失败。

先检查 preflight 返回的 CLI 路径以及文件类型；只检查程序文件，不读取认证文件。随包的 `scripts/native-transport.mjs` 是 JavaScript 入口，将 SDK 参数、stdio 和环境原样转给指定原生 CLI。

macOS/Linux 示例（`{baseDir}` 和原生路径先替换成当前安装的实际值）：

```bash
chmod u+x "{baseDir}/scripts/native-transport.mjs"
env CODEBUDDYCN_NATIVE_BIN="/verified/native/codebuddy" \
  node "{baseDir}/scripts/native-transport.mjs" --version

env CODEBUDDYCN_NATIVE_BIN="/verified/native/codebuddy" \
  CODEBUDDYCN_BIN="{baseDir}/scripts/native-transport.mjs" \
  node "{baseDir}/scripts/preflight.mjs"
```

这两条检查不请求模型。随后**每次** `codebuddycn-run.mjs` 调用都保留上述两个环境变量。它仍使用 SDK，不是 CLI 后端回退。使用者可从 `command -v codebuddy` 找到本机候选路径，再确认它不是本适配器本身；不要改写全局启动器或旧二进制。

JS CLI 启动器及 Windows `.exe` 应按实际安装检查，不盲目套用 macOS/Linux 示例。本包未在 Windows/Linux 做真实登录及端到端调用验证。

## 工具暴露与自动批准

| 设置 | 作用 |
|---|---|
| `--tools` | 向 CodeBuddy 模型暴露指定工具 |
| `--allowed-tool` | 为已获授权的工具调用配置自动批准，可重复传入 |
| `--permission-mode` | CLI 处理工具权限的模式 |
| `--add-dir` | 额外项目目录，不是操作系统文件隔离 |

先读取实际工具错误与 SDK 参数映射，不要将无头模式的权限拒绝直接解释成用户手动拒绝。较旧 SDK 曾不转发 `allowDangerouslySkipPermissions`；调用前检查当前版本，不能假定 `--skip-permissions` 必然生效。优先给已授权的必要工具配置范围明确的白名单，不以完全绕过权限作为默认排错方式。

不要因为调用者是 agent 就设置 `CODEBUDDY_IS_SANDBOX=1`。宿主审批、组织限制、操作系统沙箱或真实用户拒绝仍需遵守。

## 持久任务与恢复

- 第一轮使用 `--persistent`。监看进度用 `stream-json`；JSONL 可能包含项目内容、账户信息和工具输入，保存在私人任务目录中。
- 记录账户别名、模型、CodeBuddy 会话 ID、任务文件和输出位置。宿主执行工具的进程/session/cell ID 与 CodeBuddy 的会话 ID 不是一回事。
- JSONL 只提取必要的文本、工具名称、错误与最终 result；不要打印 thinking、环境对象或完整工具正文。
- 仅退出码 0、`ok=true` 或 assistant 文本不足以确认完成。检查最终 result、工具拒绝及实际文件；JSON 中 `result=null` 表示未捕获最终结果元数据。
- 同一会话不能由多个进程同时续跑。宿主管理句柄失效不证明 CodeBuddy 已停止，先查真实进程和输出。
- 超时或缺少最终 result 时不要立即重发 prompt。确认旧进程已停止、检查已生成文件后，使用状态明确的剩余工作说明继续原授权范围内的本地任务。外部副作用无法确认时停止重放。

同账户续跑在原命令中增加 `--resume KNOWN_SESSION_ID` 并替换本轮任务文件；账户、模型、cwd、工具、许可和输出参数都要保留。`--tools` 省略后仍为禁用，resume 不替调用者继承这些包装参数。

只有用户明确要求换账户时才用 [cross-account-resume.md](cross-account-resume.md) 的本地迁移流程。模型问题先核实当前账号可用 ID，基础设施问题先查传输、路径和权限，不因这些故障自动升级模型或换账户。
