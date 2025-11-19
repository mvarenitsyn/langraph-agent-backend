import { DynamicStructuredTool } from "@langchain/core/tools";
import { RunnableLambda } from "@langchain/core/runnables";
import { z } from "zod";
import https from "https";

/**
 * Property Search Tool
 *
 * Uses the /api/search endpoint to perform natural language property searches.
 * Always uses excludeProperties=true to get metadata + searchToken only.
 */

// API Response interfaces
interface SearchAPIResponse {
  success: boolean;
  data?: {
    searchId: string; // UUID v4 for retrieving saved search results
    properties: any[];
    totalCount: number;
    searchToken: string | null;
    pagination: {
      limit: number;
      offset: number;
      hasMore: boolean;
      nextOffset: number | null;
    };
    query: {
      original: string;
      mapped: any;
      odataFilter: string;
      queryType: string;
      intent: {
        type: string;
        isRental: boolean;
        confidence: number;
      };
    };
    geocoding: {
      googleRequests: number;
      mapboxRequests: number;
      cacheHits: number;
      failures: number;
    };
    optimization: {
      originalFieldCount: number;
      sanitizedFieldCount: number;
      fieldsSaved: number;
      reductionPercentage: number;
    };
  };
  error?: string | null;
  trestleError?: any;
  meta?: {
    processingTimeMs: number;
    timestamp: string;
  };
}

/**
 * Build human-readable summary from search results
 */
function buildSearchSummary(response: SearchAPIResponse): string {
  if (!response.success || !response.data) {
    return response.error || "Search failed";
  }

  const { totalCount, query, searchToken, searchId } = response.data;

  if (totalCount === 0) {
    return `No properties found matching "${query.original}". Try adjusting your search criteria.`;
  }

  const parts: string[] = [];

  parts.push(`Found ${totalCount} ${totalCount === 1 ? 'property' : 'properties'} matching "${query.original}".`);

  // Add query type and intent info
  if (query.queryType) {
    parts.push(`\nSearch type: ${query.queryType.replace(/_/g, ' ')}`);
  }

  if (query.intent) {
    const intentType = query.intent.isRental ? 'rental' : 'sale';
    parts.push(`Listing type: For ${intentType}`);
  }

  // Add searchId info (primary identifier for backend) - for debugging only
  if (searchId) {
    parts.push(`\n(Properties are now displayed on the interactive map)`);
  }

  // Add shareable link (for sharing search results)
  if (searchToken) {
    // Use environment variable or fallback to production URL
    const frontendUrl = process.env.FRONTEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || 'https://myvista.co';
    const shareUrl = `${frontendUrl}/search/${searchToken}`;
    parts.push(`\n🔗 Share this search: ${shareUrl}`);
  }

  return parts.join('\n');
}

/**
 * Property Search Tool
 */
export const propertySearchTool = new DynamicStructuredTool({
  name: "property_search",
  description: `Search for properties using natural language queries.

This tool uses the backend's Direct Trestle Mapper to automatically generate precise OData filters from natural language.

The backend automatically handles zero-result searches with a 2-tier retry strategy:
- Tier 1: Remove StandardStatus filter to include all property statuses
- Tier 2: Keep only core location fields (StreetNumber, StreetName, UnitNumber, City, PostalCode)

Examples:
- "2 bedroom condos in Miami under 500k"
- "luxury homes in Aventura"
- "waterfront properties in Miami Beach"`,
  schema: z.object({
    query: z.string().describe("Natural language property search query (e.g., '2 bedroom condos in Miami under 500k')"),
  }),
  func: async ({ query }, config) => {
    console.log(`[PropertySearchTool] Searching: "${query}"`);

    // Extract sessionId, userId, and userContext from config metadata (injected by custom ToolNode)
    const sessionId = (config as any)?.metadata?.sessionId;
    const userId = (config as any)?.metadata?.userId;
    const userContext = (config as any)?.metadata?.userContext || { isAuthenticated: false };

    const userName = userContext.fullName || 'Guest';
    const isAuthenticated = userContext.isAuthenticated || false;

    console.log(`[PropertySearchTool] User: ${userName} (authenticated=${isAuthenticated})`);
    console.log(`[PropertySearchTool] Using sessionId: ${sessionId}, userId: ${userId}`);

    try {
      console.log('[PropertySearchTool] 🚀 DEBUG: ABOUT TO MAKE FETCH CALL');
      console.log('[PropertySearchTool] 🚀 DEBUG: URL: https://localhost:3001/api/search');
      console.log('[PropertySearchTool] 🚀 DEBUG: Method: POST');
      const requestBody: any = {
        query,
        excludeProperties: true,
        userId,
        sessionId,
      };
      console.log('[PropertySearchTool] 🚀 DEBUG: Body:', JSON.stringify(requestBody, null, 2));

      // Create HTTPS agent that bypasses SSL verification for localhost
      const httpsAgent = new https.Agent({
        rejectUnauthorized: false,
      });

      console.log('[PropertySearchTool] 🚀 DEBUG: HTTPS Agent created, making fetch call...');

      // Make API request
      const response = await fetch('https://localhost:3001/api/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        // @ts-ignore - Node.js fetch supports agent option
        agent: httpsAgent,
      });

      console.log('[PropertySearchTool] ✅ DEBUG: FETCH COMPLETED');
      console.log('[PropertySearchTool] ✅ DEBUG: Response status:', response.status);
      console.log('[PropertySearchTool] ✅ DEBUG: Response statusText:', response.statusText);
      console.log('[PropertySearchTool] ✅ DEBUG: Response ok:', response.ok);

      if (!response.ok) {
        console.error('[PropertySearchTool] ❌ DEBUG: API ERROR - status not ok');
        const errorData = await response.json().catch(() => ({}));

        // 400 = Validation error - tell agent to simplify query
        if (response.status === 400) {
          console.error('[PropertySearchTool] ❌ OData validation error:', errorData);
          return JSON.stringify({
            success: false,
            summary: `Search criteria validation failed: ${(errorData as any).error || 'Invalid filter'}.
Try simplifying your search - use fewer criteria, broader location, or remove complex filters.`,
            validationError: true,
            odataFilter: (errorData as any).trestleError?.odataFilter,
            error: (errorData as any).error,
            trestleError: (errorData as any).trestleError
          });
        }

        // 401 = Auth error - tell agent to retry
        if (response.status === 401) {
          console.error('[PropertySearchTool] ❌ Auth error:', errorData);
          return JSON.stringify({
            success: false,
            summary: 'Authentication error. Please retry your search.',
            authError: true,
            error: 'AUTH_ERROR',
            trestleError: (errorData as any).trestleError
          });
        }

        // 500 or other = Real failure - throw to trigger agent error handling
        throw new Error(`API returned ${response.status}: ${response.statusText}`);
      }

      console.log('[PropertySearchTool] 📦 DEBUG: Parsing JSON response...');
      const data = await response.json() as SearchAPIResponse;
      console.log('[PropertySearchTool] 📦 DEBUG: Response data:', JSON.stringify(data, null, 2));

      // Build summary for LLM
      const summary = buildSearchSummary(data);

      // Return structured data including odataFilter for potential retries
      return JSON.stringify({
        success: data.success,
        summary,
        totalCount: data.data?.totalCount || 0,
        searchId: data.data?.searchId || null, // UUID v4 for retrieving search results
        searchToken: data.data?.searchToken || null, // Shareable token
        odataFilter: data.data?.query.odataFilter || null, // OData filter for retry optimization
        mapLink: data.data?.searchId
          ? `Properties are now displayed on the interactive map (searchId: ${data.data.searchId})`
          : null,
        queryMetadata: {
          original: data.data?.query.original || query,
          queryType: data.data?.query.queryType || 'unknown',
          intent: data.data?.query.intent || null,
        },
      }, null, 2);

    } catch (error) {
      console.error('[PropertySearchTool] Error:', error);

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      return JSON.stringify({
        success: false,
        summary: `Search failed: ${errorMessage}. Please try again or contact support if the issue persists.`,
        totalCount: 0,
        searchToken: null,
        mapLink: null,
        error: errorMessage,
      }, null, 2);
    }
  },
});

/**
 * Property Details Tool
 */
export const propertyDetailsTool = new DynamicStructuredTool({
  name: "property_details",
  description: "Get detailed information about a specific property by its ID",
  schema: z.object({
    propertyId: z.string().describe("The unique ID of the property (e.g., 'prop-001')"),
  }),
  func: async ({ propertyId }) => {
    console.log(`[PropertyDetailsTool] Fetching details for ${propertyId}...`);

    // TODO: Implement real property details API call
    // For now, return a placeholder message
    return JSON.stringify({
      success: false,
      message: `Property details endpoint not yet implemented. Property ID: ${propertyId}`,
    });
  },
});
