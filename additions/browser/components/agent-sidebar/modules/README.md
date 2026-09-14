# Agent 模块目录

按职责组织源码；运行流程和双模型策略见 [Runtime 架构](../../../../../docs/agent-runtime.md)。

| 目录 | 职责 | 主要入口 |
|---|---|---|
| `runtime/` | 平台无关运行时、状态内核、Ports、Worker 循环、Director 审阅与应用编排 | AgentRuntime、AgentTurnOrchestrator、AgentSupervisor、AgentLoop |
| `llm/` | 模型请求、协议转换、SSE、重试、Transport、思考等级和 Usage | LlmClient |
| `providers/` | Provider 元数据、Worker/Director 模型配置、Client 构造 | providers、ConfigStore |
| `state/` | 会话持久化和长期上下文投影 | ConversationStore、ContextProjection |
| `tools/` | 工具声明、注册和派发 | Tools、ToolRouter |
| `backends/` | Firefox/本机能力实现、Actor、工作目录、记忆、Skills 和环境管理 | Backends、PageBackend、AgentEvalChild |
| `host/` | Firefox 特权适配和进程级 Runtime 装配 | AgentSession、FirefoxAgentRuntimeHost |

## 源码路径与安装路径

常规模块由父级 `moz.build` 中对应的
`EXTRA_JS_MODULES.agentsidebar.<目录>` 安装到同名子目录。例如：

- 源码：`modules/runtime/AgentRuntime.sys.mjs`
- Firefox：`resource:///modules/agentsidebar/runtime/AgentRuntime.sys.mjs`
- Node 自测：`../modules/runtime/AgentRuntime.sys.mjs`

所有调用方必须使用分组后的路径。旧的扁平 resource URL 已移除；
仓库外的自定义脚本也需迁移，例如 AgentSession 使用
`resource:///modules/agentsidebar/host/AgentSession.sys.mjs`。

## 后续开发

- 新增模块放入职责对应的目录，并在 `moz.build` 的对应分组按大小写无关顺序登记。
- 模块内部使用相对导入，UI/Actor 使用包含目录的 resource URL。
- 修改 JSX 后先运行侧边栏的 `npm run build`，再用项目根目录的
  `bash scripts/sync-additions.sh` 同步到 Firefox 源码树并构建。
- 项目根目录运行 `bash scripts/selftest-agent-tools.sh`，覆盖双模型逻辑、
  模块清单及安装后导入链。
