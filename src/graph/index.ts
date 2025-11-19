import { StateGraph, START, END } from "@langchain/langgraph";
import { AgentState } from "../types/state.js";
import { routerNode } from "../nodes/router.js";
import { propertySearchNode } from "../nodes/property-search.js";
import { propertyFilterSortNode } from "../nodes/property-filter-sort.js";
import { propertyOperationsNode } from "../nodes/property-operations.js";
import { perplexitySearchNode } from "../nodes/perplexity-search.js";
import { createCheckpointer } from "../checkpointer/index.js";
import { initializeTools } from "../tools/index.js";

// CRITICAL: Initialize tools when this module is loaded
// This ensures tools are available for both Studio and the HTTP server
initializeTools();

/**
 * ULTRA-SIMPLIFIED LangGraph Agent - Each Node Generates Own Response
 *
 * Graph structure:
 * START → router → [conditional:
 *   - If property query → property_search → END
 *   - If filter/sort query → property_filter_sort → END (LEGACY - being deprecated)
 *   - If property operations → property_operations → END (NEW)
 *   - If research query → perplexity_search → END
 *   - Otherwise → END (router generated response)
 * ]
 *
 * Key simplifications:
 * - Router uses LLM to decide: generate response OR call specialized tool nodes
 * - property_search: MLS property search with tool loop
 * - property_filter_sort: Filter/sort existing search results with tool loop (LEGACY)
 * - property_operations: Multi-tool agent (filter, get_results, get_details) with flexible execution (NEW)
 * - perplexity_search: Web research with tool loop
 * - Each node generates its own final response
 * - NO separate generate_response node
 * - NO LOOPS at graph level, only within specialized nodes
 */

/**
 * Simple routing function from router node
 * Routes based on metadata flags set by router
 */
function routeAfterRouter(state: typeof AgentState.State) {
  const shouldSearchProperties = state.metadata?.shouldSearchProperties || false;
  const shouldFilterProperties = state.metadata?.shouldFilterProperties || false;
  const shouldUsePropertyOperations = state.metadata?.shouldUsePropertyOperations || false;
  const shouldSearchPerplexity = state.metadata?.shouldSearchPerplexity || false;

  if (shouldSearchProperties) {
    console.log(`[Graph] Routing to property_search`);
    return "property_search";
  }

  if (shouldUsePropertyOperations) {
    console.log(`[Graph] Routing to property_operations`);
    return "property_operations";
  }

  if (shouldFilterProperties) {
    console.log(`[Graph] Routing to property_filter_sort (legacy)`);
    return "property_filter_sort";
  }

  if (shouldSearchPerplexity) {
    console.log(`[Graph] Routing to perplexity_search`);
    return "perplexity_search";
  }

  // Router already generated response - go to END
  console.log(`[Graph] Router generated response - going to END`);
  return END;
}

export async function createAgentGraph() {
  console.log('[Graph] Building ultra-simplified LangGraph agent...');

  // Create the state graph - NO TOOL LOOP AT GRAPH LEVEL
  const workflow = new StateGraph(AgentState)
    // Add 5 nodes: router, property_search, property_filter_sort, property_operations, perplexity_search
    .addNode("router", routerNode)
    .addNode("property_search", propertySearchNode)
    .addNode("property_filter_sort", propertyFilterSortNode)
    .addNode("property_operations", propertyOperationsNode)
    .addNode("perplexity_search", perplexitySearchNode)

    // Add edges
    .addEdge(START, "router")

    // Conditional edge from router: property_search, property_filter_sort, property_operations, perplexity_search, or END
    .addConditionalEdges(
      "router",
      routeAfterRouter,
      ["property_search", "property_filter_sort", "property_operations", "perplexity_search", END]
    )

    // After specialized nodes, go to END (they generate their own responses)
    .addEdge("property_search", END)
    .addEdge("property_filter_sort", END)
    .addEdge("property_operations", END)
    .addEdge("perplexity_search", END);

  // Initialize checkpointer
  const checkpointer = await createCheckpointer();

  // Compile the graph with checkpointer
  const graph = workflow.compile({
    checkpointer,
  });

  console.log(`[Graph] ✓ Ultra-simplified agent graph compiled with 5 nodes (router + 4 specialized agents)`);

  return graph;
}
