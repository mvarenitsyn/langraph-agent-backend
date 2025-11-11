import { StateGraph, START, END } from "@langchain/langgraph";
import { AgentState } from "../types/state.js";
import { routerNode } from "../nodes/router.js";
import { createToolsNode } from "../nodes/tools.js";
import { reflectNode } from "../nodes/reflect.js";
import { retryNode, shouldRetryRoute } from "../nodes/retry.js";
import { generateResponseNode } from "../nodes/generate-response.js";
import { createCheckpointer } from "../checkpointer/index.js";
import { config } from "../config/index.js";
import { initializeTools } from "../tools/index.js";

// CRITICAL: Initialize tools when this module is loaded
// This ensures tools are available for both Studio and the HTTP server
initializeTools();

/**
 * LangGraph Agent with ReAct Pattern + RRR
 *
 * Graph structure:
 * START → agent → [conditional:
 *   - If tool_calls exist → tools → agent (loop back)
 *   - If no tool_calls and skipRRR → END
 *   - If no tool_calls and NOT skipRRR → reflect → retry → [back to agent OR generate_response] → END
 * ]
 */

/**
 * Routing function from agent node
 * Decides whether to call tools, skip RRR, or continue to reflection
 */
function routeAfterAgent(state: typeof AgentState.State) {
  // Check if the last message has tool_calls
  const messages = state.messages || [];
  const lastMessage = messages[messages.length - 1];

  // @ts-ignore - tool_calls exists on AIMessage
  const hasToolCalls = lastMessage?.tool_calls && lastMessage.tool_calls.length > 0;

  if (hasToolCalls) {
    console.log(`[Graph] Routing to tools node`);
    return "tools";
  }

  // No tool calls - check if we should skip RRR
  const skipRRR = state.metadata?.skipRRR;
  console.log(`[Graph] No tool calls. skipRRR=${skipRRR}`);

  return skipRRR ? "end" : "reflect";
}

export async function createAgentGraph() {
  console.log('[Graph] Building LangGraph agent with ReAct pattern...');

  // Create the tools node (lazy initialization ensures tools are registered)
  const toolsNode = createToolsNode();

  // Create the state graph
  const workflow = new StateGraph(AgentState)
    // Add nodes
    .addNode("agent", routerNode)  // Renamed from "router" to "agent" for clarity
    .addNode("tools", toolsNode)   // Dedicated tools node with all registered tools
    .addNode("reflect", reflectNode)
    .addNode("retry", retryNode)
    .addNode("generate_response", generateResponseNode)

    // Add edges
    .addEdge(START, "agent")

    // Conditional edge from agent: check for tool_calls or skip RRR
    .addConditionalEdges(
      "agent",
      routeAfterAgent,
      {
        tools: "tools",      // If tool_calls exist, execute tools
        end: END,            // Conversational messages go directly to END
        reflect: "reflect",  // Tool results continue to Reflect for quality check
      }
    )

    // After tools execute, loop back to agent to process results
    .addEdge("tools", "agent")

    .addEdge("reflect", "retry")

    // Conditional edge: retry or proceed
    .addConditionalEdges(
      "retry",
      shouldRetryRoute,
      {
        agent: "agent",        // Loop back to agent for retry
        generate_response: "generate_response", // Proceed to response generation
      }
    )

    .addEdge("generate_response", END);

  // Initialize checkpointer
  const checkpointer = await createCheckpointer();

  // Compile the graph with checkpointer
  // Note: recursionLimit is set during invocation, not compilation
  const graph = workflow.compile({
    checkpointer,
  });

  console.log(`[Graph] ✓ Agent graph compiled with tools node and PostgreSQL checkpointer`);

  return graph;
}
