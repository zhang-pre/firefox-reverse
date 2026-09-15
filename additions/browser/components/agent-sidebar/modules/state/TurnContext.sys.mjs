/* TurnContext.sys.mjs — working context for one Agent turn.
 * Cross-turn persisted projections live in ContextProjection.sys.mjs.
 * This module owns no runtime, tools, UI, or storage; effects use callbacks.
 */

const MAX_CONTEXT_CHARS = 140000;
const COMPACT_MIN_ROUNDS = 2;

// ★按模型上下文窗口缩放「压缩阈值 / trim 上限 / 单结果截断」——这是「同模型在 Claude Code 丝滑、
// 在本 Agent 毛病多」的主因：强模型(大窗口)被按小窗口(64k)的保守值过早压缩 + 狠截工具结果 →
// 反复丢状态、重读重搜 = 空转。仅靠模型名启发式分档（判不准就落默认档，绝不超窗）。
// 自定义端点跑 Opus 时模型名含 "opus" → XL 档。
export function modelBudget(model) {
  const m = String(model || "").toLowerCase();
  // XL：百万级上下文 —— opus / gemini-1.5,2 / **deepseek-v4 全系（官方 API 默认即 1M）** / 任何带 1m 标记的模型。
  // （[1m] 这类标记仍兜底识别；LlmClient 发请求时会把标记剥掉，API 收到的是纯净模型名。）
  if (/opus|gemini-(1\.5|2|exp)|deepseek-v[4-9]|(\[|[-_/])1m(\]|[-_/]|$)|1000k|1000000/.test(m)) {
    return { compactAt: 800000, maxChars: 1000000, resultCap: 150000 };
  }
  // 默认 ~200k 上下文（claude / glm·智谱 / 不带标记的 deepseek / gpt / 未知）——比原 14万 大幅放开、
  // 但留足余量不超窗。若你只用 ≥200k 的模型、想更激进，把这里也调成 1M 档即可
  //（默认保守到 200k，是因为"未知模型"可能是小窗口、发太多会硬报错）。
  return { compactAt: 250000, maxChars: 320000, resultCap: 50000 };
}

/** 机械构建进展存档（零额外 LLM 调用、确定性、有界）：工具账本 + 最近的文字叙述 + 最近一步结果摘要。
 *  fromIdx 后扫描——把模型自己的"做了什么/下一步"叙述 + 工具调用清单折成一段，老的原始 trace/输出
 *  留在工作目录文件里（要细节 fs_read）。压缩后续跑只带这段，不带原始大堆历史。 */
function buildCheckpointSummary(msgs, fromIdx) {
  const narration = [];
  const toolCounts = {};
  let lastToolResult = "";
  for (let i = Math.max(0, fromIdx); i < msgs.length; i++) {
    const m = msgs[i];
    if (!m) continue;
    if (m.role === "assistant") {
      if (m.content && String(m.content).trim()) narration.push(String(m.content).trim());
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const n = tc && tc.function && tc.function.name;
          if (n) toolCounts[n] = (toolCounts[n] || 0) + 1;
        }
      }
    } else if (m.role === "tool") {
      lastToolResult = typeof m.content === "string" ? m.content : "";
    }
  }
  const ledger =
    Object.entries(toolCounts)
      .map(([n, c]) => (c > 1 ? `${n}×${c}` : n))
      .join("、") || "（无）";
  const recent = narration.slice(-4).join("\n").slice(0, 2600) || "（暂无文字记录）";
  const tail = lastToolResult ? `\n\n最近一步工具结果(截断)：${lastToolResult.slice(0, 500)}` : "";
  const body =
    `【进展存档·自动压缩】\n已调用工具：${ledger}\n\n进展记录：\n${recent}${tail}\n\n` +
    `（以上为已压缩的早前过程；完整 trace/脚本/产物都在工作目录文件里，需要细节用 fs_read 读对应文件。）`;
  return body.slice(0, 4000);
}

// LLM 交接摘要的系统提示：要的是"让全新无记忆的自己能直接接手"，所以必须写死**已确认事实**，
// 而不是流水账——这是压缩不失忆的关键（机械摘要做不到，会丢结论导致重新发现）。
const HANDOFF_PROMPT = `你在为"上下文压缩"写 **Findings Ledger（交接账本）**：把目前进展浓缩成结构化账本，交给一个**全新、无上文记忆**的你继续。
目标：接手者**无需重新探索**就能续上——别让它重新 list 目录/搜代码/试探已确认过的东西，更别重试已否决的死路。严格按以下骨架（有则写、无则省略该节）：
## 目标定义
- 站点/接口/目标参数；目标参数的**逐字节真实样本**（取自真实请求）+ 对应输入(url/method/body)；已识别的易变字段位置(时间戳/nonce)
## 已确认事实（最重要——逐条写死、带证据，避免接手者重复发现）
- 每条格式：<事实> | 证据:<工具+关键返回片段> | 置信:高/中/低
- 涵盖：已定位的入口/函数/参数/脚本(文件名+函数名+调用方式+参数格式)、已验证的算法/数据特征、关键运行时值(签名样本/参数结构/init 配置/cookie/token 等可复用具体值)
## 已否决假设（永不重试——关键！防止接手者重走死路）
- 每条：<错误假设/试过的方向> → 否决理由(证据)
## 工作目录文件
- 路径 — 是什么 + 已分析到什么程度
## 当前阶段 + 下一步
- 阶段(P0侦察/P1定位/P2验证锁定/P3判型/P4选策略/P5补环境/P6验证) + 该阶段退出标准
- 下一步：**单条、具体、直接指向当前退出标准**（具体到工具名+参数）
只输出这份账本本身，不要调用工具、不要寒暄、不要复述本提示。`;

/** 把本回合的执行记录拍平成纯文本（避免把 tool_calls/tool 消息原样喂给无 tools 的摘要调用引发协议问题）。 */
function segmentTranscript(msgs, fromIdx) {
  const lines = [];
  for (let i = Math.max(0, fromIdx); i < msgs.length; i++) {
    const m = msgs[i];
    if (!m) continue;
    if (m.role === "assistant") {
      if (m.content && String(m.content).trim()) lines.push("[助手] " + String(m.content).trim());
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const n = tc && tc.function && tc.function.name;
          const a = tc && tc.function && tc.function.arguments;
          if (n) lines.push("[调用] " + n + (a ? " " + String(a).slice(0, 160) : ""));
        }
      }
    } else if (m.role === "tool") {
      lines.push("[结果] " + String(m.content == null ? "" : m.content).slice(0, 700));
    } else if (m.role === "user") {
      lines.push("[用户] " + (typeof m.content === "string" ? m.content : ""));
    }
  }
  return lines.join("\n").slice(0, 60000);
}

/** 让模型把本回合执行记录浓缩成结构化交接摘要（单次 chat、无 tools、输出短）。 */
async function summarizeForHandoff(client, msgs, fromIdx, signal, onUsage, cacheKey) {
  const transcript = segmentTranscript(msgs, fromIdx);
  if (!transcript) return "";
  const res = await client.chat(
    [
      { role: "system", content: HANDOFF_PROMPT },
      { role: "user", content: "以下是迄今的执行记录，据此输出交接摘要：\n\n" + transcript },
    ],
    { signal, maxTokens: 2048, cacheKey: cacheKey ? cacheKey + ":handoff" : "" }
  );
  try {
    onUsage && onUsage(res.usage, { phase: "handoff" });
  } catch {
    /* usage reporting never blocks the Agent */
  }
  return (res && res.content ? String(res.content) : "").trim();
}

function _msgSize(m) {
  let n = 0;
  if (m.content != null) {
    n += typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length;
  }
  if (m.reasoning_content) {
    n += String(m.reasoning_content).length;
  }
  if (m.tool_calls) {
    n += JSON.stringify(m.tool_calls).length;
  }
  if (m.tool_call_id) {
    n += 64;
  }
  return n;
}

const RUNTIME_CONTEXT_START = "⟪FRX_RUNTIME_CONTEXT_START⟫";
const RUNTIME_CONTEXT_END = "⟪FRX_RUNTIME_CONTEXT_END⟫";

function _stripRuntimeContext(content) {
  if (typeof content !== "string" || !content.includes(RUNTIME_CONTEXT_START)) {
    return content;
  }
  let out = content;
  for (;;) {
    const start = out.indexOf(RUNTIME_CONTEXT_START);
    if (start < 0) break;
    const end = out.indexOf(RUNTIME_CONTEXT_END, start);
    out = end < 0
      ? out.slice(0, start).trimEnd()
      : (out.slice(0, start) + out.slice(end + RUNTIME_CONTEXT_END.length)).trim();
  }
  return out;
}

function _runtimeContext(dynamicContext, ledgerText) {
  const parts = [];
  if (dynamicContext && String(dynamicContext).trim()) {
    parts.push(String(dynamicContext).trim());
  }
  if (ledgerText && String(ledgerText).trim()) {
    parts.push(String(ledgerText).trim());
  }
  return parts.length
    ? `${RUNTIME_CONTEXT_START}\n【本轮动态上下文】\n${parts.join("\n\n")}\n${RUNTIME_CONTEXT_END}`
    : "";
}

function _withRuntimeContext(message, block) {
  if (!message || !block) {
    return message;
  }
  if (Array.isArray(message.content)) {
    return {
      ...message,
      content: [...message.content, { type: "text", text: "\n\n" + block }],
    };
  }
  return {
    ...message,
    content: String(message.content || "") + "\n\n" + block,
  };
}

/**
 * 把要发给模型的消息数组裁到上下文预算内（只用于 LLM 请求；loop 自身仍保留完整 msgs 用于返回/落盘）。
 * 规则：固定保留 system(首条) + 第一条 user(原始任务)；从尾部往前尽量多保留最近轮次；
 * 切片不能以"孤儿 tool"(其 assistant 已被裁)开头——会让 OpenAI 协议报错，故往后挪过开头的 tool；
 * 中间被裁处插一条省略提示。未超预算则原样返回。
 */
function trimContext(msgs, maxChars = MAX_CONTEXT_CHARS) {
  let total = 0;
  for (const m of msgs) {
    total += _msgSize(m);
  }
  if (total <= maxChars) {
    return msgs;
  }
  let i = 0;
  const head = [];
  if (msgs[0] && msgs[0].role === "system") {
    head.push(msgs[0]);
    i = 1;
  }
  let firstUser = -1;
  for (let j = i; j < msgs.length; j++) {
    if (msgs[j].role === "user") {
      firstUser = j;
      break;
    }
  }
  if (firstUser >= 0) {
    head.push(msgs[firstUser]);
  }
  let used = 0;
  for (const m of head) {
    used += _msgSize(m);
  }
  const budget = maxChars - used;
  let keepFrom = msgs.length;
  let acc = 0;
  for (let j = msgs.length - 1; j > i; j--) {
    const s = _msgSize(msgs[j]);
    if (acc + s > budget && msgs.length - j >= 6) {
      break; // 至少保留最近 ~6 条
    }
    acc += s;
    keepFrom = j;
  }
  // 切片不能以孤儿 tool 开头（其 assistant 被裁）：往后挪过开头的 tool 消息
  while (keepFrom < msgs.length && msgs[keepFrom].role === "tool") {
    keepFrom++;
  }
  const tail = [];
  for (let j = keepFrom; j < msgs.length; j++) {
    if (head.includes(msgs[j])) {
      continue; // 别与 head 重复（firstUser 可能落在尾区）
    }
    tail.push(msgs[j]);
  }
  const elision = {
    role: "user",
    content: "（系统提示：为控制长度，已省略中间若干轮过程；早前的工具结果若需要，请 fs_read 工作目录里已落盘的文件。）",
  };
  return [...head, elision, ...tail];
}

/**
 * Create isolated working-context state. The caller owns tool execution and
 * decides when it is safe to append steering or compact the message history.
 * onCheckpoint persists the summary; this module only rebuilds model context.
 */
export async function createTurnContext({
  client, messages, systemPrompt, dynamicContext, getLedger,
  signal, onUsage, cacheKey = "", onCheckpoint, onEvent,
  budget = modelBudget(client.model || client.config?.model),
}) {
  const { maxChars, compactAt } = budget;
  let lastCompactRound = 0;
  const emit = event => {
    try { onEvent?.(event); } catch { /* Observer failures do not block context management. */ }
  };
  // 只保留 LLM 协议认得的字段——历史消息带的 UI 元数据(steps 等)若发给模型会污染上下文、引起串话。
  const sanitize = m => {
    const o = { role: m.role };
    if (m.content !== undefined) {
      o.content = _stripRuntimeContext(m.content);
    }
    if (m.tool_calls) {
      o.tool_calls = m.tool_calls;
    }
    if (m.tool_call_id) {
      o.tool_call_id = m.tool_call_id;
    }
    if (m.name) {
      o.name = m.name;
    }
    if (m.reasoning_content) {
      o.reasoning_content = m.reasoning_content; // 思考型模型多轮需保留
    }
    return o;
  };

  // Keep the system prompt byte-stable for provider prefix caching. Workspace,
  // notes, skills, cancellation boundaries, and ledger snapshots are appended
  // only to the current user task message.
  const baseSystem = systemPrompt || "";
  let ledgerText = "";
  try {
    ledgerText = getLedger ? (await getLedger()) || "" : "";
  } catch {
    /* 账本可选，取不到不影响 */
  }
  const history = messages.map(sanitize);
  let taskIndex = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "user") {
      taskIndex = i;
      break;
    }
  }
  let rawTaskAnchor = taskIndex >= 0 ? history[taskIndex] : null;
  let taskAnchor = _withRuntimeContext(
    rawTaskAnchor,
    _runtimeContext(dynamicContext, ledgerText)
  );
  if (taskIndex >= 0) {
    history[taskIndex] = taskAnchor;
  }
  const msgs = [
    ...(baseSystem ? [{ role: "system", content: baseSystem }] : []),
    ...history,
  ];

  return {
    initialMessages: msgs,

    requestMessages(messages) {
      return trimContext(messages, maxChars);
    },

    appendSteering(msgs, incoming) {
      msgs.push(...incoming.map(sanitize));
      // Preserve exact user corrections when the working history is compacted.
      rawTaskAnchor = {
        role: "user",
        content: String(rawTaskAnchor?.content || "") +
          incoming.map(message => "\n\n【用户运行中追加指令】\n" + message.content).join(""),
      };
    },

    async compact(round, msgs) {
      // ── 主动上下文压缩（先于 chat 调用）──────────────────────────────────
      // 工作上下文超阈值 → 把本回合进展折成 checkpoint（可见回复+落盘）→ 用小上下文续跑。
      // 仅当有任务锚点、且距上次压缩 ≥ COMPACT_MIN_ROUNDS 轮时触发。
      if (taskAnchor && round - lastCompactRound >= COMPACT_MIN_ROUNDS) {
        let workSize = 0;
        for (const m of msgs) {
          workSize += _msgSize(m);
        }
        if (workSize > compactAt) {
          const anchorIdx = msgs.indexOf(taskAnchor);
          const fromIdx = anchorIdx >= 0 ? anchorIdx + 1 : 0;
          // 关键：用 **LLM 生成结构化交接摘要**（保留"已确认事实/文件清单/下一步"），而不是机械截取——
          // 机械摘要会丢掉已发现的结论，导致压缩后重新探索=循环失忆（这是把压缩做对的核心）。
          // LLM 摘要失败/超时再退回机械摘要，至少不丢压缩本身。
          let summary = "";
          try {
            summary = await summarizeForHandoff(
              client,
              msgs,
              fromIdx,
              signal,
              onUsage,
              cacheKey
            );
          } catch {
            /* 摘要调用失败 → 机械兜底 */
          }
          if (!summary) {
            summary = buildCheckpointSummary(msgs, fromIdx);
          }
          emit({ type: "checkpoint", round, summary });
          if (typeof onCheckpoint === "function") {
            try {
              await onCheckpoint(summary);
            } catch {
              /* 落盘失败不阻断续跑 */
            }
          }
          // 压缩后重新取**最新账本**（含本回合 remember 的新事实）拼进 system → 确认事实永不因压缩衰减。
          let freshLedger = ledgerText;
          try {
            if (getLedger) {
              freshLedger = (await getLedger()) || "";
            }
          } catch {
            /* 取不到就沿用上次的账本快照 */
          }
          taskAnchor = _withRuntimeContext(
            rawTaskAnchor,
            _runtimeContext(dynamicContext, freshLedger)
          );
          // Rebuild a small context with the same stable system prefix. Dynamic
          // runtime data remains attached to the task anchor.
          msgs = [
            ...(baseSystem ? [{ role: "system", content: baseSystem }] : []),
            taskAnchor,
            { role: "assistant", content: summary },
            {
              role: "user",
              content:
                "（上面是你已完成的【进展存档】——已确认的事实 / 已做过的工具调用及结果 / 下一步都在里面，也已落盘 progress.md。" +
                "**铁律：存档里已经做过的事一律不要重做——别重新调用任何已调用过的工具、别重测已测过的项、别重新 list/搜索/抓包去发现已确认的信息。" +
                "若任务是清单且某些项已在存档里有结果，直接拿那些结果继续或汇总，绝不重跑。**" +
                "只在需要某个具体旧细节时才 fs_read 对应文件。现在只做存档里「下一步」指向的、尚未完成的动作。）",
            },
          ];
          lastCompactRound = round;
        }
      }

      return msgs;
    },
  };
}
