import { ToolNode } from "@langchain/langgraph/prebuilt";
import { ToolMessage } from "@langchain/core/messages";
import { globalToolsRegistry } from "../tools/registry.js";
import { AgentState } from "../types/state.js";
import { uiEventPublisher } from "../pubsub/ui-event-publisher.js";
import { isLastTask } from "../utils/platformContext.js";

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
        await emitUIEventsForTool(toolMessage, sessionId, userId, correlationId, state.metadata);
      }
    }

    return result;
  };
}

/**
 * Emit UI render events based on tool execution results
 * Note: UI events are suppressed for non-last tasks in multi-step workflows
 */
async function emitUIEventsForTool(
  toolMessage: ToolMessage,
  sessionId: string | undefined,
  userId: string | undefined,
  correlationId: string,
  metadata?: Record<string, any>
): Promise<void> {
  if (!sessionId) {
    console.log('[ToolsNode] Skipping UI event emission - no sessionId');
    return;
  }

  // Check if this is not the last task in a multi-step workflow
  if (!isLastTask({ metadata })) {
    const taskNumber = metadata?.taskNumber ?? 1;
    const totalTasks = metadata?.totalTasks ?? 1;
    console.log(`[ToolsNode] 🔇 Suppressing UI events (task ${taskNumber}/${totalTasks})`);
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

    // Handle property_filter_sort tool results
    if (toolName === 'property_filter_sort' && content.success && content.searchId) {
      // Extract filtered count from limited response
      const filteredCount = content.count || 0;
      const originalCount = content.metadata?.propertiesCount || 0;

      await uiEventPublisher.publishUIEvent({
        renderType: 'search_filtered',
        data: {
          searchId: content.searchId,
          filteredCount: filteredCount,
          originalCount: originalCount,
          executionTimeMs: content.executionTimeMs || 0,
        },
        sessionId,
        userId,
        correlationId,
      });

      console.log(`[ToolsNode] Emitted filtered UI event for searchId: ${content.searchId}, filtered: ${filteredCount} of ${originalCount}`);
    }

    // Future: Add more tool-specific UI event handlers here
    // if (toolName === 'generate_cma' && content.success && content.cmaId) { ... }
    // if (toolName === 'property_get_details' && content.success) { ... }

  } catch (error) {
    console.error('[ToolsNode] Failed to emit UI event:', error);
    // Don't throw - UI events should not break main execution
  }
}
