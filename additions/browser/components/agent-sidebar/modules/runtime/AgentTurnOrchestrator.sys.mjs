/* AgentTurnOrchestrator.sys.mjs — one Agent turn's application workflow.
 *
 * The orchestrator coordinates configuration, context projection, LLM/tool
 * execution, checkpoints, persistence, and terminal status. Session state stays
 * in AgentRuntimeCore; Firefox-specific primitives arrive through injected ports.
 */

import { slimifySteps, textFromSteps } from "./AgentRuntimeCore.sys.mjs";
import {
  assertAgentBackendsPort,
  assertAgentRouterPort,
} from "./AgentRuntimePorts.sys.mjs";
import {
  buildProjectionInput,
  CONTEXT_PROJECTION_PROMPT,
  CONTEXT_PROJECTION_VERSION,
  planContextProjection,
} from "../state/ContextProjection.sys.mjs";
import { emptyUsage, mergeUsage, normalizeUsage } from "../llm/Usage.sys.mjs";

const CANCELLED_TURN_BOUNDARY =
  "【手动取消边界】上一项任务已被用户明确手动取消。此前未完成事项只能作为历史背景，" +
  "不得自动恢复、补做或继续调用工具。请把最新一条用户消息视为新的独立请求；" +
  "只有当最新消息明确要求‘继续/恢复上一项任务’时，才可以接着执行被取消的任务。";
const NON_TERMINAL_REASONS = new Set(["max_rounds", "drift"]);
const MAX_AUTO_RESTARTS = 24;

function requireFunction(name, value) {
  if (typeof value !== "function") {
    throw new TypeError(`AgentTurnOrchestrator: ${name} must be a function`);
  }
  return value;
}

export class AgentTurnOrchestrator {
  constructor({
    runtimeCore,
    ports,
    runAgentTurn,
  } = {}) {
    if (!runtimeCore || !ports) {
      throw new TypeError(
        "AgentTurnOrchestrator: runtimeCore and normalized ports are required"
      );
    }
    this.runtimeCore = runtimeCore;
    this.configStore = ports.config;
    this.conversationStore = ports.conversations;
    this.createClient = ports.llm.createClient;
    this.runAgentTurn = requireFunction("runAgentTurn", runAgentTurn);
    this.getRouter = () =>
      assertAgentRouterPort(ports.tools.getRouter());
    this.getBackends = () =>
      assertAgentBackendsPort(ports.tools.getBackends());
    this.createToolContext = ports.tools.createContext;
    this.isVisionModel = ports.llm.isVisionModel;
    this.now = ports.clock.now;
    this.transport = ports.llm.transport;
  }

  async run(
    threadId,
    {
      systemPrompt,
      dynamicContext = "",
      convo,
      confirmMode = false,
      maxRounds = 120,
      maxPerTool = 40,
      workspaceRoot,
      hostContext,
      assist = false,
    } = {}
  ) {
    const contextStrategy = this._contextStrategy();
    const state = this.runtimeCore.beginRun(threadId, {
      usage: emptyUsage(),
      contextStrategy,
    });
    if (!state) {
      return;
    }

    const context = {
      threadId,
      state,
      systemPrompt,
      dynamicContext,
      convo,
      confirmMode,
      maxRounds,
      maxPerTool,
      workspaceRoot,
      hostContext,
      assist,
      abortController: null,
      backends: null,
      client: null,
      cacheKey: "",
      vision: false,
      recordUsage: null,
      toolContext: null,
    };

    try {
      context.abortController = this.transport.createAbortController();
      state.abort = context.abortController;
      this.runtimeCore.notify(state);
      await this._prepare(context);
      let result;
      for (;;) {
        result = await this._runUntilTerminal(context);
        if (!this.runtimeCore.hasSteering(state)) break;
        context.turnMessages = (result?.messages || context.turnMessages).filter(
          message => message && message.role !== "system"
        );
        if (result?.content) {
          context.turnMessages.push({ role: "assistant", content: result.content });
        }
      }
      // Close admission synchronously before any terminal persistence awaits.
      this.runtimeCore.closeSteering(state);
      await this._complete(context, result);
    } catch (error) {
      this.runtimeCore.closeSteering(state);
      await this._fail(context, error);
    } finally {
      await this._persistUsage(context);
      this.runtimeCore.settle(state);
    }
  }

  _contextStrategy() {
    return this.configStore.getContextStrategy &&
      this.configStore.getContextStrategy() === "legacy"
      ? "legacy"
      : "projected";
  }

  _createToolContext(input) {
    const context = this.createToolContext(input);
    if (!context || typeof context !== "object") {
      throw new TypeError(
        "AgentRuntimePorts: ports.tools.createContext() must return an object"
      );
    }
    return context;
  }

  async _prepare(context) {
    await this._consumeCancellationBoundary(context);
    context.backends = this.getBackends();
    context.toolContext = this._createToolContext({
      workspaceRoot: context.workspaceRoot || null,
      hostContext: context.hostContext || null,
      signal: context.abortController.signal,
    });
    context.client = this.createClient({
      config: this.configStore,
      transport: this.transport,
    });
    context.cacheKey = this._cacheKey(context.threadId, context.client);
    context.recordUsage = (raw, info = {}) => this._recordUsage(context, raw, info);
    context.vision = this._detectVision(context.client);
    context.turnMessages = await this._loadTurnMessages(context);
  }

  async _consumeCancellationBoundary(context) {
    let hadBoundary = false;
    try {
      hadBoundary = await this.conversationStore.consumeCancellationBoundary(
        context.threadId
      );
      await this.conversationStore.setThreadTurnStatus(context.threadId, "running");
    } catch {
      // Status metadata must not block Agent execution.
    }
    if (hadBoundary) {
      context.dynamicContext =
        String(context.dynamicContext || "") + "\n\n" + CANCELLED_TURN_BOUNDARY;
    }
  }

  _cacheKey(threadId, client) {
    const activeProfile =
      (this.configStore.getActiveModelProfile &&
        this.configStore.getActiveModelProfile()) ||
      null;
    return [
      "frx-v1",
      threadId,
      activeProfile?.id || client.providerId || "provider",
      client.model || "model",
    ]
      .join(":")
      .replace(/[^a-zA-Z0-9._:-]+/g, "_")
      .slice(0, 160);
  }

  _recordUsage(context, raw, info = {}) {
    const { state } = context;
    const client = context.client;
    const normalized = normalizeUsage(raw, {
      provider: client.providerId,
      protocol: client.protocol,
      model: client.model,
      phase: info.phase || "chat",
    });
    if (!normalized.providerReported) {
      return;
    }
    state.lastUsage = normalized;
    state.usage = mergeUsage(state.usage, normalized);
    this.runtimeCore.notifyThrottled(state);
  }

  _detectVision(client) {
    try {
      return !!this.isVisionModel(client?.model || "");
    } catch {
      return false;
    }
  }

  async _loadTurnMessages(context) {
    const fallback = Array.isArray(context.convo) ? context.convo : [];
    try {
      const thread = await this.conversationStore.getThread(context.threadId);
      if (!thread || !Array.isArray(thread.messages) || !thread.messages.length) {
        return fallback;
      }
      const fullMessages = thread.messages.map(message => ({
        role: message.role,
        content: message.content,
      }));
      if (context.state.contextStrategy !== "projected") {
        return fullMessages;
      }
      await this._updateProjection(context, thread, fullMessages);
      const messages = await this.conversationStore.getModelMessages(
        context.threadId,
        { strategy: "projected" }
      );
      const latest = await this.conversationStore.getThread(context.threadId);
      context.state.contextProjected = !!latest?.contextProjection;
      return messages;
    } catch {
      return await this._projectionFallback(context, fallback);
    }
  }

  async _updateProjection(context, thread, fullMessages) {
    const plan = planContextProjection(fullMessages, thread.contextProjection);
    if (!plan) {
      return;
    }
    const source = buildProjectionInput(fullMessages, plan);
    const projected = await context.client.chat(
      [
        { role: "system", content: CONTEXT_PROJECTION_PROMPT },
        {
          role: "user",
          content:
            "Update the continuation record from this bounded source:\n\n" +
            source,
        },
      ],
      {
        signal: context.abortController.signal,
        maxTokens: 2048,
        cacheKey: context.cacheKey + ":projection",
      }
    );
    context.recordUsage(projected.usage, { phase: "projection" });
    const summary = String(projected.content || "").trim();
    if (!summary) {
      return;
    }
    const timestamp = this.now();
    await this.conversationStore.setContextProjection(context.threadId, {
      version: CONTEXT_PROJECTION_VERSION,
      summary,
      cutoff: plan.cutoff,
      sourceCount: plan.cutoff,
      createdAt: plan.previous?.createdAt || timestamp,
      updatedAt: timestamp,
      strategy: "projected",
    });
  }

  async _projectionFallback(context, fallback) {
    try {
      const messages = await this.conversationStore.getModelMessages(
        context.threadId,
        { strategy: context.state.contextStrategy }
      );
      const latest = await this.conversationStore.getThread(context.threadId);
      context.state.contextProjected = !!latest?.contextProjection;
      return messages;
    } catch {
      return fallback;
    }
  }

  async _runUntilTerminal(context) {
    let turnMessages = context.turnMessages;
    let autoRestarts = 0;
    let driftStreak = 0;

    for (;;) {
      const result = await this.runAgentTurn(
        this._buildLoopOptions(context, turnMessages)
      );
      const reason = (result && result.stopReason) || "stop";
      if (
        context.abortController.signal.aborted ||
        context.assist ||
        !NON_TERMINAL_REASONS.has(reason)
      ) {
        return result;
      }

      driftStreak = reason === "drift" ? driftStreak + 1 : 0;
      if (driftStreak >= 2) {
        result.content =
          (result.content ? result.content + "\n\n" : "") +
          "（已停下）连续两轮只在描述/分析、没有产生实质工具动作——多半卡住了。进展已落盘（progress.md/工作目录）。" +
          "说一句你的判断、或补个我拿不到的输入（登录态/样本/方向），我再继续。";
        return result;
      }
      if (autoRestarts >= MAX_AUTO_RESTARTS) {
        result.content =
          (result.content ? result.content + "\n\n" : "") +
          `（已停下）已自动续跑 ${autoRestarts} 轮仍未给出可独立实跑的最终产物。进展已落盘。` +
          "回看上面进展，告诉我聚焦哪条路、或补个输入，我再继续。";
        return result;
      }

      autoRestarts++;
      await this._persist(
        context.threadId,
        result.content || "（继续推进）",
        context.state.steps
      );
      this._startNextSegment(context.state);
      turnMessages = (result.messages || turnMessages).filter(
        message => message && message.role !== "system"
      );
      turnMessages.push({
        role: "user",
        content:
          "（系统·自动续跑）上一段到达轮次/调用上限但任务还没完成。基于已落盘进展（progress.md/工作目录文件 + 上面对话）" +
          "继续推进到底。**绝不从头重来：上面已经做过的工具调用 / 已测过的项 / 已确认的发现一律不要重做，直接拿已有结果接着干或汇总。**" +
          "只有给出可独立实跑的产物、或真需要我提供你拿不到的东西（登录态/账号/验证码/纯业务决策）时才停。",
      });
    }
  }

  _buildLoopOptions(context, messages) {
    const {
      abortController,
      assist,
      backends,
      cacheKey,
      confirmMode,
      dynamicContext,
      maxPerTool,
      maxRounds,
      state,
      systemPrompt,
      toolContext,
      vision,
      workspaceRoot,
    } = context;
    return {
      client: context.client,
      router: this.getRouter(),
      messages,
      systemPrompt,
      dynamicContext,
      autoApprove: !confirmMode,
      assist,
      vision,
      maxRounds,
      maxPerTool,
      signal: abortController.signal,
      hasSteering: () => this.runtimeCore.hasSteering(state),
      consumeSteering: () => this._consumeSteering(context),
      toolCtx: toolContext,
      getLedger: async () => {
        try {
          return await backends.ledger.digest({}, toolContext);
        } catch {
          return "";
        }
      },
      contextStrategy: state.contextStrategy,
      cacheKey,
      onUsage: context.recordUsage,
      persistToolArtifact: workspaceRoot
        ? async ({ id, name, content }) => {
            const safeName = String(name || "tool").replace(
              /[^a-zA-Z0-9._-]+/g,
              "_"
            );
            const safeId = String(id || this.now()).replace(
              /[^a-zA-Z0-9._-]+/g,
              "_"
            );
            const path =
              `.frx-context/tool-results/${this.now()}_${safeName}_${safeId}.json`;
            const saved = await backends.workspace.write(
              { path, content },
              toolContext
            );
            return { path: saved?.path || path };
          }
        : null,
      onDelta: chunk => {
        this.runtimeCore.pushDelta(state, chunk);
        this.runtimeCore.notifyThrottled(state);
      },
      onReasoning: chunk => {
        this.runtimeCore.pushReasoning(state, chunk);
        this.runtimeCore.notifyThrottled(state);
      },
      onCheckpoint: summary => this._checkpoint(context, summary),
      onEvent: event => {
        this.runtimeCore.applyEvent(state, event);
        this.runtimeCore.notify(state);
      },
      confirm: confirmMode
        ? call => this._requestConfirmation(state, call)
        : undefined,
    };
  }

  async _consumeSteering(context) {
    const { state, threadId } = context;
    const items = this.runtimeCore.takeSteering(state);
    if (!items.length) return [];
    if (state.steps.length) {
      await this._persist(threadId, textFromSteps(state.steps), state.steps);
      this._startNextSegment(state);
    }
    const messages = [];
    for (const item of items) {
      if (context.abortController.signal.aborted) break;
      const message = { role: "user", content: item.content };
      await this.conversationStore.appendMessage(threadId, message);
      item.status = context.abortController.signal.aborted ? "cancelled" : "applied";
      if (item.status === "applied") {
        messages.push(message);
      }
    }
    state.checkpointSeq++;
    this.runtimeCore.notify(state);
    return messages;
  }

  _requestConfirmation(state, call) {
    if (this.runtimeCore.hasSteering(state) || state.aborted) return Promise.resolve(false);
    if (state.approveAll) {
      return Promise.resolve(true);
    }
    return new Promise(resolve => {
      state.pendingConfirm = {
        id: call.id,
        name: call.name,
        args: call.args,
        resolve,
      };
      this.runtimeCore.notify(state);
    });
  }

  async _checkpoint(context, summary) {
    const { backends, state, threadId, toolContext, workspaceRoot } = context;
    await this._persist(threadId, summary, state.steps);
    if (workspaceRoot) {
      try {
        await backends.workspace.write(
          { path: "progress.md", content: summary },
          toolContext
        );
      } catch {
        // A workspace checkpoint is helpful but not required for continuation.
      }
      try {
        await backends.ledger.mergeHandoff(summary, toolContext);
      } catch {
        // Ledger capture is likewise best effort.
      }
    }
    this._startNextSegment(state);
  }

  _startNextSegment(state) {
    state.steps = [];
    state._curText = -1;
    state._curThink = -1;
    state.content = "";
    state.checkpointSeq = (state.checkpointSeq || 0) + 1;
    this.runtimeCore.notify(state);
  }

  async _complete(context, result) {
    const { state, threadId } = context;
    state.aborted =
      context.abortController.signal.aborted ||
      (result && result.stopReason === "aborted");
    state.content = result?.content || textFromSteps(state.steps) || "";
    await this._persist(threadId, state.content, state.steps);
    await this._setTurnStatus(
      threadId,
      state.aborted ? "cancelled" : "completed"
    );
  }

  async _fail(context, error) {
    const { state, threadId } = context;
    state.aborted = !!context.abortController?.signal?.aborted;
    const message =
      (error && (error.message || String(error))) || "";
    const note = state.aborted
      ? "（已手动停止）"
      : "（本轮出错中断：" + message.slice(0, 160) + "）";
    state.error = state.aborted
      ? null
      : message +
        (error && error.body
          ? "\n— " + String(error.body).slice(0, 600)
          : "");
    state.content = note;
    if (state.steps.length || state.aborted) {
      await this._persist(threadId, note, state.steps);
    }
    await this._setTurnStatus(
      threadId,
      state.aborted ? "cancelled" : "failed"
    );
  }

  async _setTurnStatus(threadId, status) {
    try {
      await this.conversationStore.setThreadTurnStatus(threadId, status);
    } catch {
      // Status metadata must not block the visible result.
    }
  }

  async _persistUsage(context) {
    try {
      if (context.state.usage && context.state.usage.requests > 0) {
        await this.conversationStore.addThreadUsage(
          context.threadId,
          context.state.usage
        );
      }
    } catch {
      // Usage persistence never blocks terminal state publication.
    }
  }

  async _persist(threadId, content, steps) {
    try {
      const slim = slimifySteps(steps);
      await this.conversationStore.appendMessage(threadId, {
        role: "assistant",
        content,
        ...(slim.length ? { steps: slim } : {}),
      });
    } catch {
      // Persistence failure does not erase in-memory progress.
    }
  }
}
