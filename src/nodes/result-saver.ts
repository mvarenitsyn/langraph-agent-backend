import { AgentStateType } from '../types/state.js';
import { SearchResult } from './search-executor.js';
import { saveSearchResults, SearchSummary, initializeSearchResultsTables } from '../subgraphs/property-search/db/search-results.js';
import { MappedQuery } from '../subgraphs/property-search/types/mapped-query.js';
import { sharedPublisher } from '../pubsub/shared.js';

// Track if tables have been initialized
let tablesInitialized = false;

export interface ResultSaverOutput {
  searchId: string;
  summary: SearchSummary;
  pageInfo: {
    page: number;
    pageSize: number;
    totalPages: number;
  };
}

/**
 * Result Saver Node
 *
 * Persists deduplicated search results to PostgreSQL for:
 * - Re-sorting by any field
 * - Additional filtering
 * - Pagination
 *
 * Returns searchId + summary instead of full results array
 */
export async function resultSaverNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.log('\n[ResultSaver] Persisting search results...');

  // Publish progress update
  const { sessionId, userId, correlationId } = state.metadata || {};
  if (sessionId) {
    await sharedPublisher.publishProgressUpdate({
      sessionId,
      userId,
      correlationId,
      status: 'Saving search results...'
    });
  }

  // Initialize tables on first run
  if (!tablesInitialized) {
    try {
      await initializeSearchResultsTables();
      tablesInitialized = true;
    } catch (error) {
      console.warn('[ResultSaver] Table initialization warning:', error);
      // Continue anyway - tables might already exist
    }
  }

  const searchResults = state.toolResults?.searchResults as SearchResult[] | undefined;
  const searchStats = state.toolResults?.searchStats as {
    totalBeforeDedup?: number;
    totalAfterDedup?: number;
    duplicatesRemoved?: number;
  } | undefined;
  const mappedQuery = state.toolResults?.mappedQuery as MappedQuery | undefined;

  if (!searchResults || searchResults.length === 0) {
    console.log('[ResultSaver] No results to save');
    return {
      toolResults: {
        ...state.toolResults,
        searchId: null,
        summary: {
          total: 0,
          duplicatesRemoved: 0,
          topCities: [],
          priceRange: { min: null, max: null },
          bedroomRange: { min: null, max: null }
        },
        pageInfo: { page: 1, pageSize: 20, totalPages: 0 }
      },
      finalResponse: 'No properties found matching your criteria.',
    };
  }

  try {
    // Get thread_id from metadata or generate one
    const threadId = state.metadata?.threadId ||
                     state.metadata?.correlationId ||
                     `search-${Date.now()}`;

    // Get user_id if available
    const userId = state.userContext?.userId || state.metadata?.userId;

    // Get query text
    const queryText = state.message || '';

    // Save to database
    const { searchId, summary } = await saveSearchResults({
      threadId,
      userId,
      queryText,
      mappedQuery: (mappedQuery as unknown as Record<string, unknown>) || {},
      results: searchResults,
      duplicatesRemoved: searchStats?.duplicatesRemoved || 0
    });

    console.log(`[ResultSaver] Saved ${searchResults.length} results with searchId: ${searchId}`);

    // Calculate page info
    const pageSize = 20;
    const totalPages = Math.ceil(searchResults.length / pageSize);

    // Build response summary
    const summaryLines = [
      `Found ${summary.total} unique properties${summary.duplicatesRemoved > 0 ? ` (${summary.duplicatesRemoved} duplicates removed)` : ''}.`,
      `Search ID: ${searchId}`,
      '',
    ];

    if (summary.topCities.length > 0) {
      summaryLines.push(`Top cities: ${summary.topCities.join(', ')}`);
    }

    if (summary.priceRange.min !== null && summary.priceRange.max !== null) {
      summaryLines.push(`Price range: $${summary.priceRange.min.toLocaleString()} - $${summary.priceRange.max.toLocaleString()}`);
    }

    if (summary.bedroomRange.min !== null && summary.bedroomRange.max !== null) {
      summaryLines.push(`Bedrooms: ${summary.bedroomRange.min} - ${summary.bedroomRange.max}`);
    }

    summaryLines.push('');
    summaryLines.push(`Use searchId to get results with sorting/filtering/pagination.`);

    return {
      toolResults: {
        ...state.toolResults,
        searchId,
        summary,
        pageInfo: {
          page: 1,
          pageSize,
          totalPages
        },
        // Keep searchResults for backward compatibility but it will be removed in future
        searchResults
      },
      finalResponse: summaryLines.join('\n'),
    };

  } catch (error) {
    console.error('[ResultSaver] Error saving results:', error);

    // On error, still return results in memory (graceful degradation)
    return {
      toolResults: {
        ...state.toolResults,
        searchId: null,
        error: error instanceof Error ? error.message : 'Failed to persist results'
      },
      finalResponse: `Found ${searchResults.length} properties. (Note: Results not persisted due to database error)`,
    };
  }
}
