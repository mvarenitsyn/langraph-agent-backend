import { StateGraph, START, END } from "@langchain/langgraph";
import { AIMessage } from "@langchain/core/messages";
import { AgentState } from "../types/state.js";
import { routerNode } from "../nodes/router.js";
import { createToolsNode } from "../nodes/tools.js";
import { generateResponseNode } from "../nodes/generate-response.js";
import { createCheckpointer } from "../checkpointer/index.js";
import { initializeTools } from "../tools/index.js";

// CRITICAL: Initialize tools when this module is loaded
// This ensures tools are available for both Studio and the HTTP server
initializeTools();

/**
 * Simplified LangGraph Agent - ReAct Pattern Only
 *
 * Graph structure:
 * START → agent → [conditional:
 *   - If tool_calls exist → tools → agent (loop back to process results)
 *   - If no tool_calls → generate_response → END
 * ]
 *
 * Key simplifications:
 * - Agent ONLY decides which tools to call (no text generation)
 * - generate_response is the ONLY node that creates final user-facing text
 * - No parallel execution, no reflection, no retry, no fast-path
 * - Linear flow: agent → tools → agent → generate_response → END
 */

/**
 * Simple routing function from agent node
 * Decides whether to call tools or generate final response
 */
function routeAfterAgent(state: typeof AgentState.State) {
  const messages = state.messages || [];
  const lastMessage = messages[messages.length - 1];

  console.log(`[Graph] Checking last message type: ${lastMessage?._getType()}, total messages: ${messages.length}`);

  const hasToolCalls = lastMessage?._getType() === 'ai' &&
                       (lastMessage as AIMessage)?.tool_calls &&
                       (lastMessage as AIMessage).tool_calls.length > 0;

  if (hasToolCalls) {
    console.log(`[Graph] Tool calls found: ${(lastMessage as AIMessage).tool_calls.map(tc => tc.name).join(', ')} → Routing to tools`);
    return "tools";
  }

  // No tool calls - generate final response
  console.log(`[Graph] No tool calls → Routing to generate_response`);
  return "generate_response";
}

export async function createAgentGraph() {
  console.log('[Graph] Building simplified LangGraph agent with ReAct pattern...');

  // Create the tools node
  const toolsNode = createToolsNode();

  // Create the state graph - SIMPLIFIED VERSION
  const workflow = new StateGraph(AgentState)
    // Add only 3 nodes: agent, tools, generate_response
    .addNode("agent", routerNode)
    .addNode("tools", toolsNode)
    .addNode("generate_response", generateResponseNode)

    // Add edges
    .addEdge(START, "agent")

    // Conditional edge from agent: tools or generate_response
    .addConditionalEdges(
      "agent",
      routeAfterAgent,
      ["tools", "generate_response"]
    )

    // After tools execute, loop back to agent to process results
    .addEdge("tools", "agent")

    // Final response goes to END
    .addEdge("generate_response", END);

  // Initialize checkpointer
  const checkpointer = await createCheckpointer();

  // Compile the graph with checkpointer
  const graph = workflow.compile({
    checkpointer,
  });

  console.log(`[Graph] ✓ Simplified agent graph compiled with 3 nodes and PostgreSQL checkpointer`);

  return graph;
}
