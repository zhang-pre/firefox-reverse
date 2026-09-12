# agent-sidebar/ — Agent 侧边栏内容层

Agent 侧边栏的 **UI + LLM 调用源码层**。配合 [`patches/agent-ui/`](../../../../patches/agent-ui/README.md) 把它挂载进 Firefox chrome。方案见 [`docs/agent-sidebar.md`](../../../../docs/agent-sidebar.md)。

## 目录

| 目录 | 内容 | 打包 |
|---|---|---|
| `content/` | React 面板（`.jsx`）：AgentPanel / SettingsPane / ...（A1 待写） | 经 esbuild 打包注入 omni.ja |
| `modules/` | chrome-privileged ESM（`.sys.mjs`）：LlmClient ✅ / ConfigStore(A1) / ToolRouter(A3) / TraceBridge(A4) | 进 omni.ja |
| `dev/` | Node 自测脚本，**不随浏览器打包**（jar.mn 排除） | 否 |

## 与 jsvmp 线的文件边界（重要）

本目录属于 **Agent sidebar 线**。为与并行的 jsvmp 线零冲突，**本线不修改**：

- `additions/js/`（jsvmp C++ trace 实现）
- `patches/jsvmp-trace/`
- `tools/`（dispatcher_split.js 等 Node 工具）
- `scripts/*.py`（trace 分析器）
- `docs/agent-sidebar.md` 第 8 节、`docs/jsvmp-reverse-workflow.md`、`docs/roadmap.md`（jsvmp 线在维护）

trace 数据通过**只读契约**对接（A4 阶段），契约规格记录在 `patches/agent-ui/README.md`。

## A1 状态

| 部件 | 状态 |
|---|---|
| `modules/LlmClient.sys.mjs` | ✅ DeepSeek live 验证通过（OpenAI 兼容，deepseek/openai/custom） |
| `modules/ConfigStore.sys.mjs` | ✅ Node 单测通过（prefs/内存双 backend） |
| `modules/providers.sys.mjs` | ✅ 端到端 live 通过（ConfigStore→providers→LlmClient→DeepSeek） |
| `content/AgentPanel.jsx` + `SettingsPane.jsx` | ✅ esbuild 打包通过（jsx 语法已验证） |
| `content/index.jsx` + `panel.html` + `agent-panel.css` | ✅ 挂载入口 + 容器 + 主题样式 |
| `package.json` → `content/agent-sidebar.bundle.js` | ✅ 143.5kb minified |
| `settings/agent.example.json` | ✅ provider 配置示例 |
| sidebar 注册 patch `patches/agent-ui/0001` | ⬜ bootstrap 中，待调研 153 的 SidebarController |
| `moz.build` / `jar.mn`（注册 chrome/resource 资源） | ⬜ 待 bootstrap 后照真实格式写 |
| `apply-patches.sh` 加 `agent-ui` 模块 | ⬜ |
| 编译 macOS arm64 验证里程碑 | ⬜ |

## Node 自测 LlmClient

```bash
# dry-run：构造并打印请求，不发送、不需要 Key
node additions/browser/components/agent-sidebar/dev/selftest-llm.mjs

# 真实调用：需自备 Key
DEEPSEEK_API_KEY=sk-xxx \
  node additions/browser/components/agent-sidebar/dev/selftest-llm.mjs --live "你好"
```

## Agent Runtime 分层

| 模块 | 单一职责 |
|---|---|
| `AgentSession.sys.mjs` | Firefox 装配入口；创建 Firefox Ports，并向 UI/MCP 导出共享 Runtime 实例 |
| `AgentRuntimePorts.sys.mjs` | 正式 Host 契约；定义并校验 clock、config、conversation、LLM、tools 和 lifecycle Ports |
| `AgentRuntime.sys.mjs` | 平台无关的 composition root；通过 `createAgentRuntime({...ports})` 组装完整 Runtime |
| `AgentTurnOrchestrator.sys.mjs` | 单轮应用流程；负责上下文准备、调用 AgentLoop、自动续跑、checkpoint、持久化和终态收尾 |
| `AgentRuntimeCore.sys.mjs` | 与平台无关的内存状态内核；负责事件归约、订阅、确认、取消和线程预留 |
| `AgentLoop.sys.mjs` | 模型/工具执行循环；只通过传入的 client、router、callbacks 与外界交互 |
| `FirefoxAgentRuntimeHost.sys.mjs` | Firefox Ports 实现；把生命周期、计时器、ToolRouter、backends、LLM transport 和窗口上下文接到正式契约 |
| `LlmClient.sys.mjs` | 稳定 façade；保存规范化配置，并委托协议、流解析和请求执行 |
| `LlmProtocol.sys.mjs` | 纯协议适配；构造 OpenAI/Anthropic 请求、统一响应、翻译消息与修复文本工具调用 |
| `LlmStreamParser.sys.mjs` | 纯 SSE 增量解析；分别累积 OpenAI/Anthropic 文本、思考、工具调用和 usage |
| `LlmRequestExecutor.sys.mjs` | 请求执行策略；负责 fetch、空闲看门狗、重试和可选字段兼容回退 |
| `LlmTransport.sys.mjs` | 可注入的 fetch、AbortController 和 timer 原语 |

依赖方向为 `UI/MCP → AgentSession(Firefox 装配) → createAgentRuntime(Ports) → AgentTurnOrchestrator → AgentLoop`。Runtime 只识别 Ports 契约；`hostContext` 对 Runtime 是不透明对象，只有 Firefox Host 会把它转换成工具需要的 `win`。因此 Firefox 专属能力不能反向进入 Runtime、Core、Orchestrator、AgentLoop 或 LlmClient。

```js
const runtime = createAgentRuntime({
  clock,
  config,
  conversations,
  llm: { transport, createClient, isVisionModel },
  tools: { getRouter, getBackends, createContext },
  lifecycle: { onShutdown },
});
```

## 设计原则

- **LLM 栈零 Firefox 依赖**：网络、计时器和中止控制由 `LlmTransport` 注入，协议、流解析和请求执行模块均不 import Services/ChromeUtils，可在 Node 下独立验证。
- **LlmClient 是薄 façade**：协议扩展、SSE 解析和重试策略各自独立，Provider 与 AgentRuntime 继续只依赖原有 `LlmClient` API。
- **Key 不在 LlmClient 持久化**：由 ConfigStore 负责存取，LlmClient 只接收 `apiKey` 入参。
- **Ports 是能力白名单**：`defineAgentRuntimePorts` 校验并冻结子端口，只把契约声明的方法绑定给 Runtime，不透传完整宿主对象。
- **AgentTurnOrchestrator 零 Firefox 依赖**：单轮工作流可在 Node 中用假 Store、Client、Router 与 Backend 做契约测试。
- **AgentRuntime 可独立装配**：Node 自测只 import `createAgentRuntime`，注入内存 Ports 后直接驱动真实 AgentLoop，覆盖状态、持久化、usage、工具上下文和生命周期。
- **A1 只做 non-streaming + openai 协议**；SSE 流式与 anthropic/gemini 协议留 A2。
