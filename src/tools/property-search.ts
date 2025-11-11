import { DynamicStructuredTool } from "@langchain/core/tools";
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

  const { totalCount, query, searchToken } = response.data;

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

  // Add searchToken info
  if (searchToken) {
    parts.push(`\nSearch Token: ${searchToken}`);
    parts.push(`(Users can view these results on the interactive map using this token)`);
  }

  return parts.join('\n');
}

/**
 * Property Search Tool
 */
export const propertySearchTool = new DynamicStructuredTool({
  name: "property_search",
  description: `Search for properties using natural language queries. 
  
  This tool returns a summary of matching properties and a searchToken that users can use to view results on an interactive map.  


Examples:
- "2 bedroom condos in Miami under 500k"
- "luxury homes in Aventura"
- "waterfront properties in Miami Beach"

The tool returns the total count and a searchToken for viewing results on the map.`,
  schema: z.object({
    query: z.string().describe("Natural language property search query (e.g., '2 bedroom condos in Miami under 500k')"),
    userId: z.string().optional().describe("User ID for token expiration tracking (optional)"),
    sessionId: z.string().optional().describe("Session tracking ID (optional)"),
  }),
  func: async ({ query, userId, sessionId }) => {
    console.log(`[PropertySearchTool] Searching: "${query}"`);

    try {
      // Create HTTPS agent that bypasses SSL verification for localhost
      const httpsAgent = new https.Agent({
        rejectUnauthorized: false,
      });

      // Make API request
      const response = await fetch('https://localhost:3001/api/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          excludeProperties: true, // Always true - we only need metadata + searchToken
          userId,
          sessionId,
        }),
        // @ts-ignore - Node.js fetch supports agent option
        agent: httpsAgent,
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as SearchAPIResponse;

      // Build summary for LLM
      const summary = buildSearchSummary(data);

      // Return structured data
      return JSON.stringify({
        success: data.success,
        summary,
        totalCount: data.data?.totalCount || 0,
        searchToken: data.data?.searchToken || null,
        mapLink: data.data?.searchToken
          ? `View ${data.data.totalCount} properties on map with token: ${data.data.searchToken}`
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
