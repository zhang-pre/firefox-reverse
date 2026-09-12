/* AgentSession.sys.mjs — Firefox composition entry point.
 *
 * The reusable runtime lives in AgentRuntime.sys.mjs. This module only supplies
 * Firefox adapters and exports the process-lifetime instance used by UI/MCP.
 */

import { createAgentRuntime } from "./AgentRuntime.sys.mjs";
import { configStore } from "./ConfigStore.sys.mjs";
import { conversationStore } from "./ConversationStore.sys.mjs";
import { createFirefoxAgentRuntimePorts } from "./FirefoxAgentRuntimeHost.sys.mjs";
import { buildClientFromStore, isVisionModel } from "./providers.sys.mjs";


const ports = createFirefoxAgentRuntimePorts({
  config: configStore,
  conversations: conversationStore,
  createClient: ({ transport }) =>
    buildClientFromStore(configStore, { transport }),
  isVisionModel,
});

export const agentSession = createAgentRuntime(ports);

export function getRunLog() {
  return agentSession.getRunLog();
}
