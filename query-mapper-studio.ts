/**
 * Query Mapper Studio - Isolated LangGraph for Testing
 *
 * Run with: npm run studio
 * Then open: http://localhost:8123
 */

import { StateGraph, END } from "@langchain/langgraph";
import { queryMapperNode } from "./src/subgraphs/property-search/nodes/query-mapper.js";
import { AgentStateType } from "./src/types/state.js";

// Simple state for testing
const QueryMapperState = {
  message: "",
  metadata: {},
  toolResults: {},
  finalResponse: "",
};

// Create graph with only query-mapper node
const workflow = new StateGraph<AgentStateType>({
  channels: QueryMapperState,
})
  .addNode("query_mapper", queryMapperNode)
  .addEdge("__start__", "query_mapper")
  .addEdge("query_mapper", END);

export const queryMapperGraph = workflow.compile();

// Test invocation
if (import.meta.url === `file://${process.argv[1]}`) {
  const testQuery = "condos in Hollywood Beach";

  console.log(`\n🔬 Testing Query Mapper with: "${testQuery}"\n`);

  const start = Date.now();
  const result = await queryMapperGraph.invoke({
    message: testQuery,
    metadata: {},
  });
  const elapsed = Date.now() - start;

  console.log(`\n✓ Total Time: ${elapsed}ms`);
  console.log(`\nMapped Query:`, JSON.stringify(result.toolResults?.mappedQuery, null, 2));
}
