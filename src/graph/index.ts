import { StateGraph, START, END, Send } from "@langchain/langgraph";
import { AIMessage } from "@langchain/core/messages";
import { AgentState } from "../types/state.js";
import { routerNode } from "../nodes/router.js";
import { createToolsNode } from "../nodes/tools.js";
import { reflectNode } from "../nodes/reflect.js";
import { retryNode, shouldRetryRoute } from "../nodes/retry.js";
import { generateResponseNode } from "../nodes/generate-response.js";
import { generateStatusNode } from "../nodes/generate-status.js";
import { createCheckpointer } from "../checkpointer/index.js";
import { config } from "../config/index.js";
import { initializeTools } from "../tools/index.js";

// CRITICAL: Initialize tools when this module is loaded
// This ensures tools are available for both Studio and the HTTP server
initializeTools();

/**
 * LangGraph Agent with ReAct Pattern + RRR + Parallel Status Generation
 *
 * Graph structure:
 * START → agent → [conditional:
 *   - If tool_calls exist → Send([generate_status, tools]) → agent (fan-out, parallel execution)
 *   - If no tool_calls and skipRRR → END
 *   - If no tool_calls and NOT skipRRR → reflect → retry → [back to agent OR generate_response] → END
 * ]
 *
 * Parallel execution:
 * - generate_status: Fast GPT-3.5-turbo status messages (1-2 seconds)
 * - tools: Actual tool execution (5-30 seconds depending on tool)
 * - Both run simultaneously when tool_calls detected
 */

/**
 * Routing function from agent node
 * Decides whether to call tools (with parallel status generation), skip RRR, or continue to reflection
 *
 * Returns Send[] for parallel execution when tool_calls detected
 */
function routeAfterAgent(state: typeof AgentState.State) {
  // CRITICAL: Check LAST TWO messages because router node just added HumanMessage + AIMessage
  // The state here includes the router's output merged in
  const messages = state.messages || [];

  // Get the last message (should be AIMessage from router if tools were called)
  const lastMessage = messages[messages.length - 1];

  console.log(`[Graph] Checking last message type: ${lastMessage?._getType()}, total messages: ${messages.length}`);

  const hasToolCalls = lastMessage?._getType() === 'ai' &&
                       (lastMessage as AIMessage)?.tool_calls &&
                       (lastMessage as AIMessage).tool_calls.length > 0;

  if (hasToolCalls) {
    console.log(`[Graph] Routing to parallel execution: generate_status + tools`);
    console.log(`[Graph] Tool calls found: ${(lastMessage as AIMessage).tool_calls.map(tc => tc.name).join(', ')}`);

    // Fan-out: Both nodes run simultaneously
    // generate_status: Fast GPT-3.5 status messages (1-2 sec)
    // tools: Actual tool execution (5-30 sec)
    //
    // CRITICAL FIX: Explicitly pass tool_calls to generate_status via pendingToolCalls
    // This is needed because Send() passes state by VALUE, so the generate_status node
    // receives state snapshot BEFORE router's return value is merged
    // @ts-ignore
    const toolCalls = lastMessage.tool_calls.map(tc => ({
      id: tc.id,
      name: tc.name,
      args: tc.args
    }));

    return [
      new Send("generate_status", {
        ...state,
        pendingToolCalls: toolCalls
      }),
      new Send("tools", state),
    ];
  }

  // No tool calls - check routing
  const skipReflection = state.metadata?.skipReflection;
  const skipRRR = state.metadata?.skipRRR;

  console.log(`[Graph] No tool calls. skipReflection=${skipReflection}, skipRRR=${skipRRR}`);

  // If skip reflection only, go to generate_response (fast-path for successful searches)
  if (skipReflection) {
    console.log(`[Graph] Fast-path: Skipping reflection, going to generate_response`);
    return "generate_response";
  }

  // If skip RRR entirely, go to END
  if (skipRRR) {
    console.log(`[Graph] Skipping RRR entirely, going to END`);
    return END;
  }

  // Default: proceed to reflection
  return "reflect";
}

export async function createAgentGraph() {
  console.log('[Graph] Building LangGraph agent with ReAct pattern...');

  // Create the tools node (lazy initialization ensures tools are registered)
  const toolsNode = createToolsNode();

  // Create the state graph
  const workflow = new StateGraph(AgentState)
    // Add nodes
    .addNode("agent", routerNode)  // Renamed from "router" to "agent" for clarity
    .addNode("generate_status", generateStatusNode)  // Parallel status generation (GPT-3.5-turbo)
    .addNode("tools", toolsNode)   // Dedicated tools node with all registered tools
    .addNode("reflect", reflectNode)
    .addNode("retry", retryNode)
    .addNode("generate_response", generateResponseNode)

    // Add edges
    .addEdge(START, "agent")

    // Conditional edge from agent: check for tool_calls or skip RRR
    // Returns Send[] for parallel execution when tools detected
    .addConditionalEdges(
      "agent",
      routeAfterAgent,
      // No path mapping needed - routeAfterAgent returns Send[] for parallel execution
      // or string for single path
      ["generate_status", "tools", "reflect", "generate_response", END]
    )

    // After tools execute, loop back to agent to process results
    // This is the critical path that agent waits for
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
