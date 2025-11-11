import { ToolNode } from "@langchain/langgraph/prebuilt";
import { globalToolsRegistry } from "../tools/registry.js";

/**
 * Tools Node - Executes tool calls from the LLM
 *
 * This node is automatically invoked when the LLM returns tool_calls
 * in its response. It executes the tools and returns the results.
 *
 * NOTE: This function creates the ToolNode lazily to ensure tools are
 * registered before the node is created.
 */

export function createToolsNode() {
  // Get all registered tools
  const tools = globalToolsRegistry.getAllTools();

  console.log(`[ToolsNode] Initializing with ${tools.length} tools: ${globalToolsRegistry.getToolNames().join(', ')}`);

  // Create and return the ToolNode with all registered tools
  return new ToolNode(tools);
}
