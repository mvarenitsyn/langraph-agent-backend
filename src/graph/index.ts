import { StateGraph, START, END } from "@langchain/langgraph";
import { AgentState } from "../types/state.js";
import { routerNode } from "../nodes/router.js";
// Task orchestration nodes
import { taskExecutorNode } from "../nodes/task-executor.js";
import { taskCompleteNode } from "../nodes/task-complete.js";
import { responseSynthesizerNode } from "../nodes/response-synthesizer.js";
// Decomposed property search nodes (replaces property-search.js)
import { queryMapperNode } from "../nodes/query-mapper.js";
import { searchExecutorNode } from "../nodes/search-executor.js";
import { deduplicatorNode } from "../nodes/deduplicator.js";
import { resultSaverNode } from "../nodes/result-saver.js";
import { searchResponseGeneratorNode } from "../nodes/search-response-generator.js";
// Other specialized nodes
import { propertyFilterSortNode } from "../nodes/property-filter-sort.js";
import { propertyOperationsNode } from "../nodes/property-operations.js";
import { perplexitySearchNode } from "../nodes/perplexity-search.js";
import { collectionsNode } from "../nodes/collections.js";
import { showingsNode } from "../nodes/showings.js";
import { commissionsNode } from "../nodes/commissions.js";
import { imageSimilaritySearchNode } from "../nodes/image-similarity-search.js";
import { createCheckpointer } from "../checkpointer/index.js";
import { initializeTools } from "../tools/index.js";

// CRITICAL: Initialize tools when this module is loaded
// This ensures tools are available for both Studio and the HTTP server
initializeTools();

/**
 * OPTIMIZED LangGraph Agent - Task List Orchestration
 *
 * Graph structure (Unified Task Path):
 * START → router → [conditional:
 *   - If conversational → END (router generated response)
 *   - If task-based → task_executor → [route_node] → task_complete → [conditional:
 *       - If more tasks → task_executor (loop)
 *       - If all done → response_synthesizer → END
 *     ]
 * ]
 *
 * Route nodes (executed via task_executor):
 * - PROPERTY_SEARCH → query_mapper → search_executor → deduplicator → result_saver → search_response_generator
 * - PROPERTY_OPERATIONS → property_operations
 * - PROPERTY_FILTER → property_filter_sort (LEGACY)
 * - IMAGE_SIMILARITY_SEARCH → image_similarity_search
 * - PERPLEXITY_SEARCH → perplexity_search
 * - COLLECTIONS → collections
 * - SHOWINGS → showings
 * - COMMISSIONS → commissions
 *
 * Key features:
 * - ALL task-based queries (even single-step) go through task_executor
 * - Only conversational messages bypass task flow
 * - Multi-step workflows execute sequentially with progress updates
 * - Response synthesizer combines results from all tasks
 * - Context-aware: router knows about active search sessions (searchId)
 * - Failure handling: abort entire task list on error
 */

/**
 * Routing function from router node
 * Routes to task_executor if task list exists, otherwise END
 */
function routeAfterRouter(state: typeof AgentState.State) {
  const shouldUseTaskExecutor = state.metadata?.shouldUseTaskExecutor || false;

  if (shouldUseTaskExecutor) {
    console.log(`[Graph] Router generated task list - routing to task_executor`);
    return "task_executor";
  }

  // Conversational - router already generated response
  console.log(`[Graph] Router generated conversational response - going to END`);
  return END;
}

/**
 * Routing function from task_executor
 * Routes to appropriate route node based on current task
 */
function routeFromTaskExecutor(state: typeof AgentState.State) {
  const allTasksComplete = state.metadata?.allTasksComplete || false;

  if (allTasksComplete) {
    console.log(`[Graph] All tasks complete - routing to response_synthesizer`);
    return "response_synthesizer";
  }

  // Route based on task executor's routing flags
  const shouldSearchProperties = state.metadata?.shouldSearchProperties || false;
  const shouldFilterProperties = state.metadata?.shouldFilterProperties || false;
  const shouldUsePropertyOperations = state.metadata?.shouldUsePropertyOperations || false;
  const shouldUseImageSimilarity = state.metadata?.shouldUseImageSimilarity || false;
  const shouldSearchPerplexity = state.metadata?.shouldSearchPerplexity || false;
  const shouldUseCollections = state.metadata?.shouldUseCollections || false;
  const shouldUseShowings = state.metadata?.shouldUseShowings || false;
  const shouldUseCommissions = state.metadata?.shouldUseCommissions || false;

  if (shouldSearchProperties) {
    console.log(`[Graph] Task executor routing to query_mapper (property search)`);
    return "query_mapper";
  }

  if (shouldUsePropertyOperations) {
    console.log(`[Graph] Task executor routing to property_operations`);
    return "property_operations";
  }

  if (shouldFilterProperties) {
    console.log(`[Graph] Task executor routing to property_filter_sort (legacy)`);
    return "property_filter_sort";
  }

  if (shouldUseImageSimilarity) {
    console.log(`[Graph] Task executor routing to image_similarity_search`);
    return "image_similarity_search";
  }

  if (shouldSearchPerplexity) {
    console.log(`[Graph] Task executor routing to perplexity_search`);
    return "perplexity_search";
  }

  if (shouldUseCollections) {
    console.log(`[Graph] Task executor routing to collections`);
    return "collections";
  }

  if (shouldUseShowings) {
    console.log(`[Graph] Task executor routing to showings`);
    return "showings";
  }

  if (shouldUseCommissions) {
    console.log(`[Graph] Task executor routing to commissions`);
    return "commissions";
  }

  // Fallback - should not happen
  console.log(`[Graph] Task executor - no routing flag set, going to response_synthesizer`);
  return "response_synthesizer";
}

/**
 * Routing function after task_complete
 * Loops back to task_executor if more tasks, otherwise to response_synthesizer
 */
function routeAfterTaskComplete(state: typeof AgentState.State) {
  const hasMoreTasks = state.metadata?.hasMoreTasks || false;
  const taskFailed = state.metadata?.taskFailed || false;

  if (taskFailed) {
    // Task failed - go to response synthesizer to generate error response
    console.log(`[Graph] Task failed - routing to response_synthesizer for error handling`);
    return "response_synthesizer";
  }

  if (hasMoreTasks) {
    console.log(`[Graph] More tasks remaining - routing back to task_executor`);
    return "task_executor";
  }

  console.log(`[Graph] All tasks complete - routing to response_synthesizer`);
  return "response_synthesizer";
}

export async function createAgentGraph() {
  console.log('[Graph] Building task-orchestrated LangGraph agent...');

  // Create the state graph with task orchestration
  const workflow = new StateGraph(AgentState)
    // Router node - generates task list or conversational response
    .addNode("router", routerNode)

    // Task orchestration nodes
    .addNode("task_executor", taskExecutorNode)
    .addNode("task_complete", taskCompleteNode)
    .addNode("response_synthesizer", responseSynthesizerNode)

    // Property search pipeline (5 sequential nodes)
    .addNode("query_mapper", queryMapperNode)
    .addNode("search_executor", searchExecutorNode)
    .addNode("deduplicator", deduplicatorNode)
    .addNode("result_saver", resultSaverNode)
    .addNode("search_response_generator", searchResponseGeneratorNode)

    // Other specialized nodes
    .addNode("property_filter_sort", propertyFilterSortNode)
    .addNode("property_operations", propertyOperationsNode)
    .addNode("perplexity_search", perplexitySearchNode)
    .addNode("collections", collectionsNode)
    .addNode("showings", showingsNode)
    .addNode("commissions", commissionsNode)
    .addNode("image_similarity_search", imageSimilaritySearchNode)

    // ========== EDGES ==========

    // START → router
    .addEdge(START, "router")

    // Router → task_executor (if task list) OR END (if conversational)
    .addConditionalEdges(
      "router",
      routeAfterRouter,
      ["task_executor", END]
    )

    // Task executor → route nodes OR response_synthesizer (if all complete)
    .addConditionalEdges(
      "task_executor",
      routeFromTaskExecutor,
      [
        "query_mapper",
        "property_filter_sort",
        "property_operations",
        "image_similarity_search",
        "perplexity_search",
        "collections",
        "showings",
        "commissions",
        "response_synthesizer",
      ]
    )

    // Property search pipeline: sequential chain → task_complete
    .addEdge("query_mapper", "search_executor")
    .addEdge("search_executor", "deduplicator")
    .addEdge("deduplicator", "result_saver")
    .addEdge("result_saver", "search_response_generator")
    .addEdge("search_response_generator", "task_complete")

    // All other route nodes → task_complete
    .addEdge("property_filter_sort", "task_complete")
    .addEdge("property_operations", "task_complete")
    .addEdge("image_similarity_search", "task_complete")
    .addEdge("perplexity_search", "task_complete")
    .addEdge("collections", "task_complete")
    .addEdge("showings", "task_complete")
    .addEdge("commissions", "task_complete")

    // Task complete → task_executor (loop) OR response_synthesizer
    .addConditionalEdges(
      "task_complete",
      routeAfterTaskComplete,
      ["task_executor", "response_synthesizer"]
    )

    // Response synthesizer → END
    .addEdge("response_synthesizer", END);

  // Initialize checkpointer
  const checkpointer = await createCheckpointer();

  // Compile the graph with checkpointer
  const graph = workflow.compile({
    checkpointer,
  });

  console.log(`[Graph] ✓ Task-orchestrated agent graph compiled with 16 nodes`);
  console.log(`[Graph]   - Task orchestration: router → task_executor → task_complete → response_synthesizer`);
  console.log(`[Graph]   - Route nodes: property search (5), property_ops, filter, image_similarity, perplexity, collections, showings, commissions`);

  return graph;
}
