import { ToolNode } from "@langchain/langgraph/prebuilt";
import { ToolMessage } from "@langchain/core/messages";
import { globalToolsRegistry } from "../tools/registry.js";
import { AgentState } from "../types/state.js";
import { uiEventPublisher } from "../pubsub/ui-event-publisher.js";

/**
 * Tools Node - Executes tool calls from the LLM with session context
 *
 * This node is automatically invoked when the LLM returns tool_calls
 * in its response. It executes the tools and returns the results.
 *
 * This custom wrapper injects sessionId and userId from state into the
 * tool execution config, making them accessible to tools that need them.
 */

export function createToolsNode() {
  // Get all registered tools
  const tools = globalToolsRegistry.getAllTools();

  console.log(`[ToolsNode] Initializing with ${tools.length} tools: ${globalToolsRegistry.getToolNames().join(', ')}`);

  // Create base ToolNode
  const baseToolNode = new ToolNode(tools);

  // Wrap with custom node that injects session context and emits UI events
  return async (state: typeof AgentState.State, config?: any) => {
    // Extract context from state metadata
    const sessionId = state.metadata?.sessionId;
    const userId = state.metadata?.userId;
    const correlationId = state.metadata?.correlationId || 'unknown';
    const userContext = state.metadata?.userContext || state.userContext;

    console.log(`[ToolsNode] Injecting session context: sessionId=${sessionId}, userId=${userId}`);

    // Merge session context into config
    const enhancedConfig = {
      ...config,
      metadata: {
        ...config?.metadata,
        sessionId,
        userId,
        userContext,
      },
    };

    // Execute base tool node with enhanced config (ToolNode.invoke method)
    const result = await baseToolNode.invoke(state, enhancedConfig);

    // Check if any tools returned UI-renderable data and emit events
    if (result.messages && result.messages.length > 0) {
      const lastMessage = result.messages[result.messages.length - 1];

      if (lastMessage && 'type' in lastMessage && lastMessage.type === 'tool') {
        const toolMessage = lastMessage as ToolMessage;
        await emitUIEventsForTool(toolMessage, sessionId, userId, correlationId);
      }
    }

    return result;
  };
}

/**
 * Emit UI render events based on tool execution results
 */
async function emitUIEventsForTool(
  toolMessage: ToolMessage,
  sessionId: string | undefined,
  userId: string | undefined,
  correlationId: string
): Promise<void> {
  if (!sessionId) {
    console.log('[ToolsNode] Skipping UI event emission - no sessionId');
    return;
  }

  try {
    const toolName = toolMessage.name;
    const content = typeof toolMessage.content === 'string'
      ? JSON.parse(toolMessage.content)
      : toolMessage.content;

    // Handle property_search tool results
    if (toolName === 'property_search' && content.success && content.searchId) {
      await uiEventPublisher.publishSearchResults({
        searchId: content.searchId,
        totalCount: content.totalCount || 0,
        searchToken: content.searchToken,
        mapLink: content.mapLink,
        sessionId,
        userId,
        correlationId,
      });

      console.log(`[ToolsNode] Emitted UI event for searchId: ${content.searchId}`);
    }

    // Future: Add more tool-specific UI event handlers here
    // if (toolName === 'generate_cma' && content.success && content.cmaId) { ... }
    // if (toolName === 'property_get_details' && content.success) { ... }

  } catch (error) {
    console.error('[ToolsNode] Failed to emit UI event:', error);
    // Don't throw - UI events should not break main execution
  }
}
