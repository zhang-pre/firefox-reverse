/* AgentLoop.sys.mjs — Agent 的 tool_use 循环（脊梁，Phase N0）。
 *
 * 把 LlmClient（聊天）与 ToolRouter（工具）编织起来：
 *   LLM 返回 tool_calls → 逐个 ToolRouter.dispatch → 结果回灌 → 再问 LLM，
 *   直到 LLM 不再要工具或达到 maxRounds。OpenAI 协议（DeepSeek V4 已支持 function calling）。
 *
 * 零 Firefox 依赖：client / router 注入，可 Node 自测。
 */

import { createTurnContext, modelBudget } from "../state/TurnContext.sys.mjs";
import { STAGE_CHECKPOINT_TOOL, validateStageCheckpoint } from "./AgentSupervisor.sys.mjs";

// 单条工具结果回灌进对话上下文的字符上限。超出只截头部+提示分段读，避免长会话上下文无界膨胀→TTFT 超时。
const TOOL_RESULT_CAP = 6000;

// 模型连续返回"纯文字、不调工具"的最多自动续跑次数。超过就当它真的停了（防纯文字死循环空转）。
const MAX_AUTO_CONTINUE = 3;

// 【输出被长度限制截断】的专用重试上限——**与 autoContinue/drift 完全解耦**。
// 思考型模型(DeepSeek reasoner 等)的 reasoning_content 不受 prompt 约束、长度无界：难题轮里
// reasoning 可能吃满 max_tokens，还没产出 content/tool_call 就被切(finish_reason=length，只剩"<"之类零碎)。
// 这**不是**"模型漂走不动手"(drift)，而是"该少想多做"——若把它当 autoContinue 累计，3 次就误判 drift、
// 外层再两轮 drift 就"已停下"→ 用户看到的"DeepSeek 跑一会突然截断然后会话停了"。故截断走独立计数、不污染 drift。
const MAX_TRUNC_RETRIES = 6;
// 回灌给下一轮的 reasoning_content 上限：思考型模型每轮 reasoning 可达数千字，整段回灌会撑爆 80K 上下文
// → trimContext 把真正的工具结果挤掉 → 模型丢状态、反复重读重跑(兜圈子)。只留尾部(结论/"所以我要调用X"常在尾部)，
// 既满足"必须带 reasoning_content 字段"的中转，又不让它吃上下文。(Anthropic/Opus 不回灌这段，故无此问题。)
const REASONING_FEEDBACK_CAP = 1200;

// A2 重复熔断**豁免名单**：这些工具"同参重复"是正当的——每次都有真实副作用或推进世界状态，
// 不是空转。page_scroll 滚动加载新内容、page_navigate 重载、trace start/stop/clear 开关、
// page_eval 触发请求/取不同时刻的值、page_click 交互。误把它们当空转拦掉，会逼模型绕路（实测踩到）。
// 真正该熔断的是**纯只读查询**（jsvmp_query/net_list/fs_list/code_search…）反复拿同一结果。
const REPEAT_EXEMPT = new Set([
  "addons_manage",
  "page_scroll",
  "page_navigate",
  "page_click",
  "page_type",
  "page_eval",
  "page_screenshot",
  "jsvmp_trace",
  "webapi_trace",
  "net_capture",
  "run_node",
  "run_python",
  "fs_write",
  "npm_install",
]);

// 反绕圈：同一(工具+错误签名)累计到这个次数 → 在结果里注入"换路线"提示。
const SAME_ERR_PIVOT_AT = 3;
// 连续失败(任意类型，不限同类)到这个次数 → 提示别再用同套方式空转重复（换思路/换工具/核对前提；
// 确有不同且有把握的下一步仍可继续用工具，不硬停）。抓"各种错连环出现=空转/退化"，
// 是 SAME_ERR_PIVOT_AT 抓不到的另一种空转：空参数调用/截断/超限轮番出现）。
const CONSEC_ERR_AT = 6;

// 取字符串里**第一个配平的顶层 {…}**（正确跳过字符串/转义）。模型偶尔在合法 JSON 后附加多余
// 文字/第二个对象 → JSON.parse 报 "unexpected non-whitespace character after JSON data"；
// 提取首个对象即可丢弃尾部噪声。
function _extractFirstJsonObject(s) {
  const start = s.indexOf("{");
  if (start < 0) {
    return null;
  }
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (c === "\\") {
      esc = true;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) {
      continue;
    }
    if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        return s.slice(start, i + 1);
      }
    }
  }
  return null;
}

// 容错解析工具参数 JSON：先直接 parse；失败则剥 ```json 围栏、再取首个配平对象。仍失败抛原错。
function parseToolArgs(raw) {
  if (raw == null || raw === "") {
    return {};
  }
  const s = String(raw);
  try {
    return JSON.parse(s);
  } catch (e) {
    const fenced = s.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
    if (fenced !== s) {
      try {
        return JSON.parse(fenced);
      } catch {
        /* 继续兜底 */
      }
    }
    const obj = _extractFirstJsonObject(fenced);
    if (obj !== null && obj !== fenced) {
      try {
        return JSON.parse(obj);
      } catch {
        /* 落到抛原错 */
      }
    }
    throw e;
  }
}
// A2 重复调用熔断用：给一次调用算"调用签名"= 工具名 + 归一化参数（数字/hex/引号内容/空白归一，
// 使"同一意图、参数无实质变化"的反复调用得同签名）。
function _callSig(name, args) {
  let s = "";
  try {
    s = JSON.stringify(args || {});
  } catch {
    s = String(args);
  }
  const norm = s
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, "#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, "")
    .slice(0, 200);
  return name + "|" + norm;
}
// A2：给一次工具结果算"结果指纹"——只取**信息量特征**（ok/错误签名/数量/大小/少量内容头），
// 用于判断"重复调用是否带来了新信息"。两次 callSig 相同且 resultFp 相同 = 纯空转。
function _resultFp(env) {
  if (!env || typeof env !== "object") {
    return String(env);
  }
  const parts = [];
  parts.push(env.ok === false ? "err" : "ok");
  // 常见"数量/状态"字段：count/length/size/bytes/exitCode/cleared/capturing…
  for (const k of ["count", "callCount", "watLines", "funcCount", "exitCode", "size", "bytes", "cleared", "capturing", "tracing", "hasTrace"]) {
    if (env[k] !== undefined) {
      parts.push(k + "=" + JSON.stringify(env[k]));
    }
  }
  // 列表类：长度即可（内容不进指纹，避免大对象）
  for (const k of ["requests", "entries", "hits", "records", "calls", "functions", "exports"]) {
    if (Array.isArray(env[k])) {
      parts.push(k + ".len=" + env[k].length);
    }
  }
  // 错误文本头（归一）
  if (env.ok === false) {
    const e = String(env.error || env.note || "").toLowerCase().replace(/\d+/g, "#").slice(0, 80);
    parts.push("e:" + e);
  }
  return parts.join(",");
}

// A1 无进展预算用：判定一次工具调用是否构成"真实前进"（机械、不靠模型自述）。
// 真前进 = 产生了新的、有价值的状态变化：成功落盘脚本/文件、抓到带调用栈的请求、wasm_probe 出 calls、
// trace 有非空记录、写了产物文件等。纯查询(失败/count=0/列表没变)不算前进。
function _isProgress(name, env) {
  if (!env || env.ok === false) {
    return false;
  }
  // 写盘/落盘类工具成功 = 前进
  if (/^(addons_manage|scripts_save|fs_write|fs_copy|fs_mkdir|wasm_disasm|jsvmp_split_dispatcher|jsvmp_disassemble|js_trace|notes_add)$/.test(name)) {
    return true;
  }
  // run_node/run_python：**只有脚本真的跑成功**才算前进。"进程跑起来了"(env.ok)≠"脚本逻辑成功"——
  // 很多脚本 catch 后照样 exit 0 却打印报错/"对不上"，那是在死胡同里换脚本兜圈子、不是前进。
  // 实测教训：WASM 复刻兔子洞里 100+ 次 run_node 每次跑个坏 loader 全被当"前进"→ A1 无进展预算永远清零、
  // 永不触发换路线提示。故要求 exitCode===0 且合并输出里**没有异常签名**。
  if (/^run_(node|python)$/.test(name) && env.exitCode === 0 && !env.timedOut) {
    const out = String(env.output || "");
    const looksFailed =
      /Error:|Exception\b|Traceback|is not defined|is not a function|Cannot (read|find)|\babort(ed)?\b|ReferenceError|TypeError|SyntaxError|RangeError|ERR_[A-Z]|MODULE_NOT_FOUND|ENOENT|Unhandled|panicked|❌|不匹配|对不上|复刻失败|验证失败/i.test(
        out
      );
    return !looksFailed;
  }
  // net_get 拿到带发起者栈的请求 = 关键前进
  if (name === "net_get" && env.request && Array.isArray(env.request.initiatorStack) && env.request.initiatorStack.length) {
    return true;
  }
  // wasm_probe 抓到 wbg 调用 / webapi_query 有指纹 / 抓到非空列表 = 前进
  if (Array.isArray(env.calls) && env.calls.length) return true;
  if (typeof env.count === "number" && env.count > 0) return true;
  for (const k of ["requests", "hits", "entries", "records", "exports", "functions"]) {
    if (Array.isArray(env[k]) && env[k].length > 0) return true;
  }
  return false;
}

// 给失败的工具结果算一个"错误类别签名"：归一掉数字/hex/引号内容/路径 → 同类错误得同签名。
// 失败判定：env.ok===false；错误文本取 env.error，或 run_node/python 失败时合并输出的尾部。
function _errSig(name, env) {
  if (!env || env.ok) {
    return null;
  }
  const raw = env.error ? String(env.error) : env.output ? String(env.output) : "";
  if (!raw) {
    return null;
  }
  // 取"错误消息行"作签名，**跳过栈帧(at ...:line:col)**——栈位置每次不同，会让同类错误得不同签名。
  const lines = raw.split("\n").map(s => s.trim()).filter(Boolean);
  let msg = "";
  for (const ln of lines) {
    if (/^at\s/i.test(ln)) {
      continue;
    }
    if (/(error|cannot|undefined|is not|not a function|not defined|failed|拒绝|失败|找不到|超过|不可用)/i.test(ln)) {
      msg = ln;
      break;
    }
  }
  if (!msg) {
    msg = lines.find(l => !/^at\s/i.test(l)) || lines[0] || "";
  }
  // 归一掉数字/hex/引号内容/路径 → 同类错误同签名（如不同 reading 'x'/'y' → 同签名）。
  const norm = msg
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, "")
    .replace(/['"`][^'"`]*['"`]/g, "")
    .replace(/[/\\][^\s)]+/g, "")
    .replace(/[0-9]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return norm ? name + "|" + norm : null;
}

/**
 * 运行一个 Agent 回合。
 * @param {object} p
 * @param {{ chat: Function }} p.client            LlmClient 实例（或同形 mock）
 * @param {{ listSpecs:Function, dispatch:Function }} p.router  ToolRouter 实例
 * @param {Array} p.messages                       既有对话（不含 system）
 * @param {string} [p.systemPrompt]                追加到首位的 system 消息
 * @param {number} [p.maxRounds=6]                 防工具死循环上限
 * @param {AbortSignal} [p.signal]
 * @param {object} [p.toolCtx]                     透传给工具 handler 的 ctx
 * @param {(ev:object)=>void} [p.onEvent]          每步事件回调（供 UI 展示）
 * @param {(call:object)=>Promise<boolean>} [p.confirm]  改动型工具执行前征求批准（A3）
 * @param {boolean} [p.autoApprove=false]          true 则跳过确认（headless/MCP 受信场景）
 * @returns {Promise<{content:string, rounds:number, toolCalls:Array, messages:Array, stopReason:string}>}
 */
export async function runAgentTurn(p) {
  const {
    client,
    router,
    messages,
    systemPrompt,
    dynamicContext,
    maxRounds = 6,
    maxPerTool = 8,
    signal,
    toolCtx = {},
    onEvent,
    onDelta,
    onReasoning, // 思考型模型的 reasoning_content 增量回调（供 UI 展示"思考过程"）
    hasSteering = () => false,
    consumeSteering,
    onCheckpoint, // 上下文压缩时回调(summary)：引擎据此把进展落盘成一条可见回复 + 重置实时步骤
    onUsage, // (rawUsage, {phase})：统一统计由上层按 provider 规范化并持久化
    persistToolArtifact, // 大工具结果落工作目录；返回 {path}，上下文只保留头尾与引用
    getLedger, // 取任务账本注入块的回调(async→string)：每轮开头+每次压缩后拼进系统提示，确认事实永不衰减
    confirm,
    autoApprove = false,
    assist = false, // AI辅助逐阶段模式：无工具的纯文字回复=正常收尾（停下报告+给方向），不当 drift 逼它继续
    vision = false, // 模型是否支持看图：true 时把截图等图像作为 user 图片消息回喂
    contextStrategy = "legacy", // projected=小上下文+大结果折叠；legacy=旧行为，可随时回退
    cacheKey = "",
    stageGate = null, // Runtime-owned supervised stage and per-segment dispatch budget.
  } = p || {};

  if (!client || typeof client.chat !== "function") {
    throw new Error("runAgentTurn: client.chat required");
  }
  if (!router || typeof router.dispatch !== "function") {
    throw new Error("runAgentTurn: router required");
  }
  if (!Array.isArray(messages)) {
    throw new Error("runAgentTurn: messages array required");
  }

  // ★按当前模型上下文窗口缩放预算（强模型少压缩/少截结果 → 少空转、少重读重搜）。从 client.model 解析，
  // 判不准落默认档（=现状，安全）。注意用局部变量、不改模块常量 → 多会话并发安全。
  const _bud = modelBudget(client.model || (client.config && client.config.model));
  // 单工具结果进上下文的截断上限：**随窗口缩放**（默认档 50k / 大模型 150k）。
  // ★修复旧 bug：以前这里写死 TOOL_RESULT_CAP=6000 又砍一刀，把 modelBudget 给大模型放大的 resultCap(150k) 架空了
  //   → 强模型实际只能看到每条结果 6KB。现在改用 _bud.resultCap，缩放真正生效。
  const legacyResultCap = (_bud && _bud.resultCap) || TOOL_RESULT_CAP;
  const resultCap =
    contextStrategy === "projected"
      ? Math.min(legacyResultCap, 12000)
      : legacyResultCap;
  try {
    if (router && _bud.resultCap) {
      // Projected mode needs the full envelope long enough to save an artifact,
      // then AgentLoop folds it before the next model request.
      router.maxChars =
        contextStrategy === "projected"
          ? Math.max(_bud.resultCap, 256 * 1024)
          : _bud.resultCap;
    }
  } catch {
    /* router 无此字段也不影响 */
  }

  const emit = ev => {
    try {
      onEvent && onEvent(ev);
    } catch {
      /* UI 回调不影响主流程 */
    }
  };

  const turnContext = await createTurnContext({
    client, messages, systemPrompt, dynamicContext, getLedger,
    signal, onUsage, cacheKey, onCheckpoint, onEvent: emit, budget: _bud,
  });
  let msgs = turnContext.initialMessages;

  // Stable order is part of the provider cache prefix.
  const tools = router
    .listSpecs()
    .slice()
    .sort((a, b) =>
      String(a?.function?.name || "").localeCompare(String(b?.function?.name || ""))
    );
  if (stageGate) tools.push(STAGE_CHECKPOINT_TOOL);
  const allToolCalls = [];
  const dispatchBudget = stageGate ? Math.max(1, Math.min(20, stageGate.toolBudget || 20)) : Infinity;
  let dispatched = 0;
  let gateReason = "";
  let checkpoint = null;
  const toolCounts = {}; // 每个工具本回合调用次数（防打转）
  const failSigs = {}; // (工具+错误签名) → 次数（反绕圈：同错反复出现就提示换路线）
  let consecErr = 0; // 连续失败计数（任意类型错；任一成功即清零）——抓"各种错连环=空转"
  let autoContinues = 0; // 连续"纯文字不调工具"的自动续跑计数（防过早结束 + 防死循环）
  let truncRetries = 0; // 【输出长度截断】专用重试计数——与 autoContinues 解耦，截断不算"漂移"，免误判停
  // A2 重复调用熔断：callSig → { fp:上次结果指纹, n:连续相同结果次数 }。同调用同结果≥阈值=空转，引擎拒执行。
  const repeatTracker = new Map();
  const REPEAT_BREAK_AT = 10; // 6→10：A2 是唯一还硬拒的护栏，但它只在**同参数+同结果**(确实零新信息)时触发——
  // 这种纯机械 runaway 才该拦。再给强模型更多空间（10 次同参同结果才兜底），其余空转交给软提示/连续失败护栏。
  // A1 无进展预算：自上次"真实前进"以来的工具调用数；连续 NO_PROGRESS_BUDGET 次零前进 → 强制决策回合。
  let noProgress = 0;
  const NO_PROGRESS_BUDGET = 12; // 配合 _isProgress 修正(失败的 run_node 不再误计为前进)：这下能真累计了，稍早一点提醒换路线
  let forcedDecisionPending = false; // 已注入强制决策提示、等模型给出"切换/继续(带证据)/阻塞报告"

  async function applySteering() {
    if (signal?.aborted || typeof consumeSteering !== "function") return false;
    const incoming = await consumeSteering();
    if (signal?.aborted || !incoming?.length) return false;
    turnContext.appendSteering(msgs, incoming);
    autoContinues = 0;
    truncRetries = 0;
    return true;
  }

  for (let round = 1; round <= maxRounds; round++) {
    // 手动停止（侧边栏「停止」按钮 abort）：在轮次边界干净退出，返回已有进展。
    if (signal && signal.aborted) {
      emit({ type: "aborted", round });
      return {
        content: "（已手动停止）",
        rounds: round - 1,
        toolCalls: allToolCalls,
        messages: msgs,
        stopReason: "aborted",
      };
    }

    await applySteering();
    if (signal?.aborted) break;

    msgs = await turnContext.compact(round, msgs);

    await applySteering();
    if (signal?.aborted) break;
    emit({ type: "round", round });
    const res = await client.chat(turnContext.requestMessages(msgs), {
      tools,
      signal,
      onDelta,
      onReasoning,
      cacheKey,
    });
    try {
      onUsage && onUsage(res.usage, { phase: "chat" });
    } catch {
      /* usage reporting never blocks the Agent */
    }

    const toolCalls = res.toolCalls || [];
    if (toolCalls.length === 0 && hasSteering() && !signal?.aborted) {
      msgs.push({ role: "assistant", content: res.content || "" });
      await applySteering();
      continue;
    }
    if (signal?.aborted) break;
    if (toolCalls.length === 0) {
      // 模型没调工具就回了。可能 ①真完成 ②真要用户输入 ③只是"复述计划/进展"漂走了没动手
      // （尤其压缩后 [任务+存档+继续提示] 很容易引出一段纯文字回复）。③ 会让自主执行**过早结束**
      // ——这正是用户看到的"自己停下不动了"。判断是否真结论：含结论/求助/已完成才真停，否则注入
      // "现在就执行下一步"逼它真的调工具继续。autoContinues 封顶防纯文字死循环；任一工具调用即清零。
      const txt = String(res.content || "");
      const reasoningLen = (res.reasoningContent || "").length;
      // 【截断判定】(Fix 2，对中转鲁棒)：标准是 finish_reason=length/max_tokens；但不少中转在流被切时
      // 不回标准 finish_reason，故再加"reasoning 吃满预算"特征签名——无工具调用 + content 只剩零碎(<8 字) +
      // reasoning 很长(>2000 字) → 几乎一定是思考型模型把 max_tokens 全耗在 reasoning 上、没产出调用就被切。
      const truncated =
        res.finishReason === "length" ||
        res.finishReason === "max_tokens" ||
        (txt.trim().length < 8 && reasoningLen > 2000);

      // 【截断专用处理】(Fix 1)：与 drift/autoContinue **完全解耦**。截断不是"漂移不动手"，是"想太多被切"——
      // 若按 autoContinue 累计，3 次就误判 drift、外层再两轮 drift 即"已停下"=用户实测的"DeepSeek 跑一会突然
      // 截断然后会话停了"。故：不碰 autoContinues、不把那半截废思考回灌（白占 80K 预算还会顺着想下去），
      // 只塞一条硬指令逼它这轮极简推理直奔工具调用，retry。仅当连续截断到上限才停（且给可行动报告，不走 drift）。
      if (truncated) {
        truncRetries++;
        if (truncRetries > MAX_TRUNC_RETRIES) {
          emit({ type: "final", content: res.content, round });
          return {
            content:
              (res.content || "") +
              `\n\n（已停下）模型连续把输出预算耗在"思考"上、始终没发出工具调用就被长度限制切断` +
              `（思考型模型的 reasoning 无法靠提示压住）。进展已落盘。建议换更稳的模型（如 Claude）续跑，或把该模型 max_tokens 调大。`,
            rounds: round,
            toolCalls: allToolCalls,
            messages: msgs,
            stopReason: "final", // 走 final 停下等用户决策；**不**走 drift（drift 两轮即停且文案误导成"只在描述分析"）
          };
        }
        msgs.push({ role: "assistant", content: txt || "（上轮思考超长被截断）" });
        msgs.push({
          role: "user",
          content:
            "（系统）你上一条把输出预算几乎全耗在思考上、**还没发出工具调用就被长度限制截断了**。" +
            "这一轮**严禁长篇推理**：基于已知信息用最多一两句话说清要做什么，**立刻发出一个工具调用**。" +
            "若同一处已反复试不通，别再钻——换路线（浏览器当 oracle：page_eval 调页面里的 signer 拿「输入→签名」真值对照；或 jsvmp_trace 看 VM 算法）。",
        });
        continue;
      }

      // ── 非截断的"无工具纯文字"：真结论 or 漂移 ──
      // 真结论才停：有结论小标题/明确求助/已完成（正则即可区分真结论与零碎字符）。
      const looksFinal =
        /##\s*结论|结论[:：]|已(全部)?完成|无法继续|搞不定|需要你|需要您|请你提供|请您提供|请提供|麻烦你|等你|等您|你来决定|由你决定/.test(
          txt
        );
      // AI辅助模式：任一无工具的纯文字回复都当作"阶段门停"——做完本阶段的工具动作后，模型发一条
      // 「汇报发现+给方向选项」的纯文字，本回合即收尾交回用户等其选方向（不 drift 逼它跳下一阶段）。
      if (assist || looksFinal || autoContinues >= MAX_AUTO_CONTINUE) {
        // 【drift 自诊断】非 assist/非真结论却停 = 模型连续只输出文字计划、不调工具（drift）。旧版只把模型那段
        // 计划文字原样抛给用户就停 → 用户看着像"莫名其妙中断"。这里补一句**为什么停 + 怎么办**，让中断不再神秘。
        const isDrift = !assist && !looksFinal;
        const driftDiag = isDrift
          ? "\n\n---\n（系统）⚠ 模型**连续多次只输出文字计划、不调用工具**就停了 —— 不是任务做完，是模型卡在「工具调用」这一步。" +
            "这通常是**模型侧**问题：① 推理档（`deepseek-reasoner` / R1）**不支持 function calling**，只会叙述下一步、不会真的发起工具调用；" +
            "② DeepSeek 在**超长上下文 + 高频工具调用**下，到「思考完→发起调用」的边界容易退化成纯文字。" +
            "**换 `deepseek-v4-flash`（支持工具、稳）或 Claude 续跑**即可；进展已落盘，开回原工作目录可接着干。"
          : "";
        emit({ type: "final", content: res.content + driftDiag, round });
        return {
          content: (res.content || "") + driftDiag,
          rounds: round,
          toolCalls: allToolCalls,
          messages: msgs,
          // assist/looksFinal=停下等用户 → "final"；否则全自动下连续纯文字攒满 → "drift"（上层自动续跑）。
          stopReason: assist || looksFinal ? "final" : "drift",
        };
      }
      // 漂走/只说计划 → 推进它真的动手，不结束本轮。
      autoContinues++;
      msgs.push({ role: "assistant", content: txt });
      msgs.push({
        role: "user",
        content:
          "（系统）别只描述计划/复述进展——**现在就调用工具执行你说的下一步**。" +
          "任务没完成就一直推进到底；只有真正需要我提供你拿不到的东西（登录态/账号/验证码/纯业务决策）、" +
          "或任务已全部完成（给出可独立实跑的产物）时才停。" +
          "**若你已反复搜索/静态分析同一处仍无进展，立刻换路线**：签名器能在浏览器调用就转 jsdom/node 补环境实跑、" +
          "用 XHR/fetch 拦截器把目标参数截出来对照，而不是继续静态找定义。",
      });
      continue;
    }
    autoContinues = 0; // 有真实工具调用 → 清零（只数"连续纯文字空转"）
    truncRetries = 0; // 成功产出工具调用 → 清零截断重试计数（只数**连续**截断，免长会话零星截断攒到上限误停）

    // 回灌：assistant 的 tool_calls 消息必须原样保留，再跟每个 tool 结果。
    // 思考型模型(deepseek-v4-pro 等)要求把本轮 reasoning_content 一并回灌，否则下一轮 400；
    // 但整段 reasoning 每轮可达数千字，全回灌会撑爆 80K 上下文、把真工具结果挤掉 → 模型丢状态、反复重读重跑(兜圈子)。
    // 故只回灌尾部 REASONING_FEEDBACK_CAP 字（结论/"所以我现在要调用 X"通常落在尾部）：既满足"字段在"、又不吃上下文。
    const asstMsg = { role: "assistant", content: res.content ?? "", tool_calls: toolCalls };
    if (res.reasoningContent) {
      asstMsg.reasoning_content =
        res.reasoningContent.length > REASONING_FEEDBACK_CAP
          ? "…" + res.reasoningContent.slice(-REASONING_FEEDBACK_CAP)
          : res.reasoningContent;
    }
    msgs.push(asstMsg);

    for (const tc of toolCalls) {
      if (signal && signal.aborted) {
        break; // 手动停止：跳出，外层轮次边界会干净返回
      }
      if (hasSteering()) {
        // Finish the protocol batch before inserting any new user messages.
        const remaining = toolCalls.slice(toolCalls.indexOf(tc));
        for (const skipped of remaining) {
          const name = skipped.function?.name;
          const env = { ok: false, skipped: true, error: "Skipped: new user steering supersedes this pending tool call" };
          msgs.push({ role: "tool", tool_call_id: skipped.id, content: JSON.stringify(env) });
          allToolCalls.push({ name, args: {}, env, id: skipped.id });
          emit({ type: "tool_call", name, args: {}, id: skipped.id });
          emit({ type: "tool_result", name, env, id: skipped.id });
        }
        break;
      }
      const name = tc.function?.name;
      if (stageGate && (gateReason || dispatched >= dispatchBudget)) {
        gateReason ||= "segment_budget";
        const env = { ok: false, skipped: true, error: "Runtime 阶段门已暂停，本调用未执行；等待 Director 决策后重新提交。" };
        msgs.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(env) });
        emit({ type: "tool_call", name, args: {}, id: tc.id });
        emit({ type: "tool_result", name, env, id: tc.id });
        continue;
      }
      let args = {};
      let parseErr = null;
      try {
        args = tc.function?.arguments ? parseToolArgs(tc.function.arguments) : {};
      } catch (e) {
        // 最常见原因：输出被 max_tokens 截断(finish_reason=length) → arguments JSON 被切断
        // （多见于把整个大文件当 fs_write 的 content 一次性写出）。给可操作提示，
        // 避免模型对同一超大写入盲目重试同样会再截断。
        const truncated =
          res.finishReason === "length" ||
          res.finishReason === "max_tokens" ||
          /end of data|unterminated|unexpected end/i.test(e.message || "");
        parseErr = truncated
          ? `工具参数被输出长度限制截断（finish_reason=${res.finishReason || "length"}，本次调用未执行）。` +
            `⚠ **别再重发同样的大内容**——重试还会被截断、白白卡住会话。改用其一：` +
            `① 若是要复制/改一个**已落盘的文件**（如已 scripts_save 的 glue）→ 用 \`fs_copy(src,dst)\` 拷现成的、` +
            `再只写几十行小 loader/补丁，**绝不要 fs_write 把大文件全文重写**；` +
            `② 确需新写大文件 → 分多段 \`fs_write({path,content,append:true})\` 每段 ≤2KB；` +
            `③ 缩短本轮思考/少灌内容。（原始解析错误：${e.message}）`
          : `工具参数 JSON 非法（${e.message}）。请**只**发一个完整合法的 JSON 对象作为该工具参数，` +
            `别在它后面再附加说明文字/第二个对象/\`\`\` 代码块标记；复杂字符串值（如 callExpr）里的引号、反斜杠、换行要正确转义。`;
      }
      emit({ type: "tool_call", name, args, id: tc.id });
      toolCounts[name] = (toolCounts[name] || 0) + 1;

      // A2 重复调用熔断（纯机械、模型绕不过）：同一(工具+归一化参数)已连续 ≥REPEAT_BREAK_AT 次
      // 拿到**相同结果指纹**（无新信息）→ 引擎直接拒绝执行，逼它换动作/换工具。掐死
      // jsvmp_query(count=0) 反复、fs_list 连发、net_capture→scroll→net_list 空转这类死循环。
      // 豁免有副作用的工具（滚动/导航/trace 开关/触发请求等）——它们同参重复是正当的，不算空转。
      const callSig = parseErr || REPEAT_EXEMPT.has(name) ? null : _callSig(name, args);
      const rep = callSig ? repeatTracker.get(callSig) : null;
      const repeatBlocked = !!(rep && rep.n >= REPEAT_BREAK_AT);

      // 改动型工具（page_eval/navigate/intercept/save/trace…）执行前征求用户批准（A3）。
      // 默认安全：需确认但既无 confirm 回调也没 autoApprove → 拒绝。
      let env;
      if (parseErr) {
        env = { ok: false, error: parseErr };
      } else if (stageGate && name === "stage_checkpoint") {
        try {
          checkpoint = validateStageCheckpoint(args);
          gateReason = "stage_checkpoint";
          env = { ok: true, data: { stage: stageGate.stage, awaitingDirector: true, checkpoint } };
        } catch (error) {
          env = { ok: false, error: error.message };
        }
      } else if (repeatBlocked) {
        env = {
          ok: false,
          error:
            `⛔ 已用**相同参数**调用 ${name} ${rep.n + 1} 次、每次结果都一样（无新信息）——这是空转。` +
            `引擎已拒绝再次执行。**别重发同样的调用**：要么改参数（换 filter/换脚本/换 offset）、` +
            `要么换工具、要么换策略。若该策略确实走不通，按账本登记"已否决假设(带证据)"再换路线，别原地磨。`,
        };
      } else if (router.needsConfirm(name)) {
        emit({ type: "confirm_request", name, args, id: tc.id });
        let approved = autoApprove;
        if (!approved && typeof confirm === "function") {
          approved = await confirm({ name, args, id: tc.id });
        }
        emit({ type: "confirm_result", name, id: tc.id, approved: !!approved });
        approved = approved && !signal?.aborted && !hasSteering();
        env = approved
          ? (dispatched++, await router.dispatch(name, args, toolCtx))
          : { ok: false, error: "user denied tool execution", denied: true };
      } else {
        dispatched++;
        env = await router.dispatch(name, args, toolCtx);
      }

      const evidenceId = stageGate && name !== "stage_checkpoint" ? `tool:${stageGate.scope}:${allToolCalls.length + 1}` : undefined;
      allToolCalls.push({ name, args, env, id: tc.id, ...(evidenceId ? { evidenceId } : {}) });
      emit({ type: "tool_result", name, env, id: tc.id });

      // A2：更新重复跟踪。被熔断拒绝(repeatBlocked)的不计入；正常执行后比对结果指纹：
      // 与上次相同→n++（逼近阈值）；不同（有新信息）→重置为 0。换了参数=新 callSig=独立计数。
      if (callSig && !repeatBlocked) {
        const fp = _resultFp(env);
        const prev = repeatTracker.get(callSig);
        if (prev && prev.fp === fp) {
          prev.n += 1;
        } else {
          repeatTracker.set(callSig, { fp, n: 1 });
        }
      }

      // A1：真实前进则清零预算 + 清空强制决策态；否则累加。被熔断/被拒的不算前进。
      if (!repeatBlocked && _isProgress(name, env)) {
        noProgress = 0;
        forcedDecisionPending = false;
      } else {
        noProgress++;
      }

      // 图像（截图）走 env.media 旁路：不塞进工具文本结果（否则爆 token / 被截断）。
      const media = Array.isArray(env.media) ? env.media : null;
      const envText = media ? { ok: env.ok, data: env.data, error: env.error, meta: env.meta } : env;
      // 单条工具结果进上下文的硬上限：防长会话(逆向多步、page_eval/fs_read 大输出)上下文无界增长
      // → 请求体越来越大 → 模型 TTFT 超过空闲看门狗(默认300s)一字未回 → 误报「连接超时」/撞上下文窗。
      // 大结果只截给模型一个头部 + 可操作提示；完整内容仍在侧栏事件与落盘文件里，要细节让模型分段 fs_read。
      let contentStr = JSON.stringify(envText);
      if (contentStr.length > resultCap) {
        const originalChars = contentStr.length;
        let artifact = null;
        if (typeof persistToolArtifact === "function") {
          try {
            artifact = await persistToolArtifact({
              id: tc.id,
              name,
              content: contentStr,
              chars: originalChars,
            });
          } catch {
            /* artifact persistence is optional */
          }
        }
        const reference = artifact?.path
          ? `折叠前结果已保存到 ${artifact.path}；需要细节请用 fs_read 分段读取或 code_search 精确搜索。`
          : "未设置工作目录或保存失败；需要细节请缩小查询范围后重新获取。";
        const marker =
          `\n…⟪旧工具输出已折叠，原始 ${originalChars} 字符。${reference}⟫…\n`;
        const room = Math.max(1000, resultCap - marker.length);
        const headChars = Math.floor(room * 0.65);
        const tailChars = room - headChars;
        contentStr =
          contentStr.slice(0, headChars) +
          marker +
          contentStr.slice(-tailChars);
      }
      // 反绕圈护栏：同一(工具+错误签名)累计到阈值 → 在结果里注入"换路线"硬提示（依据 skill §6 决策树）。
      const sig = _errSig(name, env);
      if (sig) {
        failSigs[sig] = (failSigs[sig] || 0) + 1;
        if (failSigs[sig] >= SAME_ERR_PIVOT_AT) {
          contentStr +=
            `\n\n⟪⚠ 你已第 ${failSigs[sig]} 次用 ${name} 撞同一类错误。别再用同样方式重试——这多半不是再补一个 stub/参数能解决，是路线/初始化链不对。换路线(见 skill_get §6 决策树)：` +
            `①浏览器当 oracle：page_eval 调页面里的 signer 拿「输入→签名」真值对照(零补环境先验证可行)；` +
            `②转路径A：jsvmp_trace 直接看 VM 算法；③仍不行就把卡点+已知信息报告用户。⟫`;
        }
      }
      // 【maxPerTool 改软提示，不再硬熔断】旧版"同一工具本回合超 N 次就拒执行"是**一刀切**——长逆向任务里
      // run_node/code_search/page_eval 正当地要调几十上百次（每次不同脚本/不同搜索=都有进展），硬熔断会把活
      // 生生的任务掐断（用户实测痛点："很长的 Agent 任务不可能一刀切"）。现在**绝不拦执行**，只在跨过阈值时
      // **偶尔附一句温和提醒**。真正的空转交给 A2(同参同结果熔断，纯机械绕不过) + 下面的连续失败护栏 + maxRounds 兜——
      // 它们只在**确无新信息/连环失败**时才触发，不误伤"高频但每次有进展"的正当调用。
      if (toolCounts[name] > maxPerTool && (toolCounts[name] - maxPerTool - 1) % 20 === 0) {
        contentStr +=
          `\n\n⟪提示：${name} 本回合已调用 ${toolCounts[name]} 次——长任务这很正常、继续无妨，只要每次有新进展即可。` +
          `（同参同结果会被自动熔断、连环失败会另有提示；都没触发就说明你在正常推进，放心干。）⟫`;
      }
      // 连续失败护栏（任意类型，不限同类）：连环失败=空转/退化 → 强提示停手。
      if (env && env.ok === false) {
        consecErr++;
        if (consecErr >= CONSEC_ERR_AT) {
          contentStr +=
            `\n\n⟪⚠ 连续 ${consecErr} 次工具调用都失败了——很可能在空转。**别再用同样的方式重试/猜参数/重发大内容**；换个思路、换个工具、或先核对前提（路径是否存在、参数格式对不对、前置步骤做了没）。若你确有**不同且有把握**的下一步，**照常继续用工具**（包括刚失败的这个）；若只是在重复同类尝试，就停下、基于已有信息给结论或说清卡在哪、需要什么（进展已落盘不丢）。⟫`;
        }
      } else if (env && env.ok === true) {
        consecErr = 0;
      }
      msgs.push({
        role: "tool",
        tool_call_id: tc.id,
        content: evidenceId ? `${contentStr}\nRuntime evidenceId: ${evidenceId}` : contentStr,
      });

      // 视觉回喂：模型支持看图时，把图像作为 user 图片消息追加，让模型"看见"页面。
      if (media && media.length && vision) {
        const blocks = [
          { type: "text", text: `（${name} 返回 ${media.length} 张图，请据此判断页面与下一步操作）` },
        ];
        for (const m of media) {
          if (m && m.type === "image" && m.dataUrl) {
            blocks.push({ type: "image_url", image_url: { url: m.dataUrl } });
          }
        }
        if (blocks.length > 1) {
          msgs.push({ role: "user", content: blocks });
        }
      }
    }

    if (stageGate && (gateReason || dispatched >= dispatchBudget) && !signal?.aborted) {
      const stopReason = gateReason || "segment_budget";
      return {
        content: checkpoint ? JSON.stringify(checkpoint) : `Runtime 分段预算已达 ${dispatchBudget} 次工具派发，提交已有证据审阅。`,
        rounds: round, toolCalls: allToolCalls, messages: msgs, stopReason,
        checkpoint, dispatched,
      };
    }

    // A1 无进展软提醒（轻量、不强制）：连续 NO_PROGRESS_BUDGET 次零真实前进 → 注入**一条温和提醒**，
    // 提示它"可能在绕，停下想想最有把握的一条路推到底，或如实报告卡点"。只提醒一次（fired 后不再重复打扰）。
    // 不再做"三选一强制裁决"——按精简法，方法论交给 skill、判断交给模型，引擎只做轻护栏不越俎代庖。
    if (noProgress >= NO_PROGRESS_BUDGET && !forcedDecisionPending) {
      forcedDecisionPending = true;
      emit({ type: "forced_decision", noProgress });
      msgs.push({
        role: "user",
        content:
          `（系统·提醒）你已连续约 ${noProgress} 次工具调用没明显推进（没新落盘/没抓到关键数据/结果在重复）。` +
          `不是逼你停——只是提个醒：若在反复试同类手段，**挑一条你最有把握的路推到判决**（要么跑出结果，要么确认此路不通再换）；` +
          `若确实卡住，如实说清卡在哪、还需要什么。然后继续。`,
      });
    }
  }

  if (signal?.aborted || hasSteering()) {
    return {
      content: signal?.aborted ? "（已手动停止）" : "",
      rounds: maxRounds, toolCalls: allToolCalls, messages: msgs,
      stopReason: signal?.aborted ? "aborted" : "max_rounds",
    };
  }
  emit({ type: "max_rounds", maxRounds });
  // 轮数用尽：不带工具再问一次，逼模型基于已有工具结果直接给结论，而不是空停。
  let summary = "";
  try {
    const fin = await client.chat(turnContext.requestMessages(msgs), {
      signal,
      onDelta,
      onReasoning,
      cacheKey,
    });
    try {
      onUsage && onUsage(fin.usage, { phase: "final" });
    } catch {
      /* usage reporting never blocks the Agent */
    }
    summary = fin.content || "";
  } catch {
    /* 总结失败就退回提示 */
  }
  emit({ type: "final", content: summary, round: maxRounds });
  return {
    content:
      summary ||
      `（已达最大轮数 ${maxRounds}，仍未得出结论。可换个问法、缩小范围，或分步让我做。）`,
    rounds: maxRounds,
    toolCalls: allToolCalls,
    messages: msgs,
    stopReason: "max_rounds",
  };
}
