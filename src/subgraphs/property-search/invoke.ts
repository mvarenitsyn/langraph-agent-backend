/**
 * ES Subgraph Invocation Wrapper
 *
 * Provides a clean interface to invoke the property_search_v2 subgraph
 * from the main agent's property_search tool.
 */

import { createPropertySearchGraph } from './graph.js';
import { AgentStateType } from '../../types/state.js';
import { SearchSummary } from './db/search-results.js';

// Cache the compiled graph for reuse
let cachedGraph: Awaited<ReturnType<typeof createPropertySearchGraph>> | null = null;

export interface ESSearchResult {
  searchId: string | null;
  summary: SearchSummary;
  totalCount: number;
  pageInfo: { page: number; pageSize: number; totalPages: number };
  error?: string;
}

export interface InvokeMetadata {
  threadId: string;
  userId?: string;
  sessionId?: string;
  correlationId?: string;
}

/**
 * Invoke the ES-based property search subgraph
 *
 * @param query - Natural language search query
 * @param metadata - Session metadata (threadId, userId, sessionId)
 * @returns Search result with searchId, summary, and pageInfo
 */
export async function invokePropertySearch(
  query: string,
  metadata: InvokeMetadata
): Promise<ESSearchResult> {
  console.log(`[InvokePropertySearch] Starting ES search for: "${query}"`);
  console.log(`[InvokePropertySearch] Metadata:`, {
    threadId: metadata.threadId,
    userId: metadata.userId || 'anonymous',
    sessionId: metadata.sessionId || 'none',
  });

  try {
    // Lazy-load and cache the graph
    if (!cachedGraph) {
      console.log('[InvokePropertySearch] Creating property search graph...');
      cachedGraph = await createPropertySearchGraph();
      console.log('[InvokePropertySearch] ✓ Graph cached');
    }

    // Create minimal state for subgraph invocation
    const state: Partial<AgentStateType> = {
      message: query,
      messages: [],
      metadata: {
        threadId: metadata.threadId,
        userId: metadata.userId,
        sessionId: metadata.sessionId,
        correlationId: metadata.correlationId || metadata.sessionId,
      },
      userContext: metadata.userId ? { userId: metadata.userId, isAuthenticated: true } : { isAuthenticated: false },
    };

    console.log('[InvokePropertySearch] Invoking subgraph...');
    const startTime = Date.now();

    // Invoke the subgraph
    const result = await cachedGraph.invoke(state);

    const elapsed = Date.now() - startTime;
    console.log(`[InvokePropertySearch] ✓ Subgraph completed in ${elapsed}ms`);

    // Extract results from toolResults
    const toolResults = result.toolResults || {};
    const searchId = toolResults.searchId as string | null;
    const summary = (toolResults.summary || {
      total: 0,
      duplicatesRemoved: 0,
      topCities: [],
      priceRange: { min: null, max: null },
      bedroomRange: { min: null, max: null },
    }) as SearchSummary;
    const pageInfo = (toolResults.pageInfo || { page: 1, pageSize: 20, totalPages: 0 }) as {
      page: number;
      pageSize: number;
      totalPages: number;
    };

    console.log(`[InvokePropertySearch] Results:`);
    console.log(`  - searchId: ${searchId}`);
    console.log(`  - total: ${summary.total}`);
    console.log(`  - duplicates removed: ${summary.duplicatesRemoved}`);
    console.log(`  - top cities: ${summary.topCities?.join(', ') || 'none'}`);

    // Check for errors
    if (result.error) {
      console.error(`[InvokePropertySearch] Error in subgraph: ${result.error}`);
      return {
        searchId: null,
        summary,
        totalCount: 0,
        pageInfo,
        error: result.error,
      };
    }

    return {
      searchId,
      summary,
      totalCount: summary.total || 0,
      pageInfo,
    };

  } catch (error) {
    console.error('[InvokePropertySearch] Fatal error:', error);

    return {
      searchId: null,
      summary: {
        total: 0,
        duplicatesRemoved: 0,
        topCities: [],
        priceRange: { min: null, max: null },
        bedroomRange: { min: null, max: null },
      },
      totalCount: 0,
      pageInfo: { page: 1, pageSize: 20, totalPages: 0 },
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Clear the cached graph (useful for testing or hot-reloading)
 */
export function clearGraphCache(): void {
  cachedGraph = null;
  console.log('[InvokePropertySearch] Graph cache cleared');
}
