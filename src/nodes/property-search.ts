import { AIMessage, HumanMessage, ToolMessage, SystemMessage } from "@langchain/core/messages";
import { AgentStateType } from "../types/state.js";
import { createResponseModel } from "../models/openai.js";
import { uiEventPublisher } from "../pubsub/ui-event-publisher.js";
import { sharedPublisher } from "../pubsub/shared.js";
import { getPlatformContext, shouldPublishUIEvents } from "../utils/platformContext.js";
import { buildFormattingInstructions, adaptMarkdown, truncateResponse } from "../utils/formatters.js";

/**
 * NOTE: This file is DEPRECATED - property search is now handled by the decomposed pipeline:
 * router → query_mapper → search_executor → deduplicator → result_saver → search_response_generator
 *
 * This file remains for backward compatibility but should not be used.
 */

/**
 * Property Search Node - Optimized Direct Tool Execution
 *
 * PERFORMANCE OPTIMIZATION:
 * This node directly executes the property_search tool WITHOUT an LLM decision step.
 * We already know we need to search (router sent us here), so we skip the unnecessary
 * "should I call the tool?" LLM call that was costing 1-2 seconds.
 *
 * Flow:
 * 1. DIRECTLY call property_search tool with user query (no LLM decision)
 * 2. Generate user-friendly response from results
 *
 * Previous flow (SLOW):
 * 1. LLM decides to call tool (1-2s) ❌ REMOVED
 * 2. Execute tool (12s)
 * 3. LLM generates response (5-6s)
 *
 * New flow (FAST):
 * 1. Execute tool directly (12s)
 * 2. LLM generates response (5-6s)
 *
 * Savings: 1-2 seconds per search
 */
export async function propertySearchNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.log('[PropertySearch] DEPRECATED: This node should not be called. Use the decomposed pipeline instead.');
  console.log('[PropertySearch] Use: router → query_mapper → search_executor → deduplicator → result_saver → search_response_generator');

  return {
    error: 'Property search node is deprecated',
    finalResponse: 'This search method is deprecated. Please use the updated search pipeline.',
  };
}
