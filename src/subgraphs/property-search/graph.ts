import { StateGraph, START, END } from "@langchain/langgraph";
import { AgentState } from "../../types/state.js";
import { queryMapperNode } from "./nodes/query-mapper.js";
import { searchExecutorNode } from "./nodes/search-executor.js";
import { deduplicatorNode } from "./nodes/deduplicator.js";
import { resultSaverNode } from "./nodes/result-saver.js";

/**
 * Property Search V2 Subgraph
 *
 * A testable subgraph for LangGraph Studio that can run independently
 * and later integrate into the main agent graph.
 *
 * Flow:
 * START → query_mapper → search_executor → deduplicator → result_saver → END
 *
 * - query_mapper: Parses user query into structured MappedQuery (uses gpt-4o-mini)
 * - search_executor: Executes hybrid ES + PG search
 * - deduplicator: Removes duplicate addresses, prioritizes Active > Pending > Closed, Sales > Rentals
 * - result_saver: Persists results to PostgreSQL, returns searchId + summary for pagination/sorting
 */

export async function createPropertySearchGraph() {
  console.log('[PropertySearchV2] Building subgraph...');

  const workflow = new StateGraph(AgentState)
    .addNode("query_mapper", queryMapperNode)
    .addNode("search_executor", searchExecutorNode)
    .addNode("deduplicator", deduplicatorNode)
    .addNode("result_saver", resultSaverNode)

    // Edges
    .addEdge(START, "query_mapper")
    .addEdge("query_mapper", "search_executor")
    .addEdge("search_executor", "deduplicator")
    .addEdge("deduplicator", "result_saver")
    .addEdge("result_saver", END);

  // Compile without checkpointer for now (Studio will handle state)
  const graph = workflow.compile();

  console.log('[PropertySearchV2] ✓ Subgraph compiled with query_mapper → search_executor → deduplicator → result_saver');

  return graph;
}
