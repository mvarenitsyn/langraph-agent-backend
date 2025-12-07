/**
 * ES-Based Property Search Tool
 *
 * Replaces the HTTP-based property_search tool with direct Elasticsearch search
 * via the property_search_v2 subgraph.
 *
 * Benefits:
 * - No HTTP round-trip to backend
 * - Hybrid ES search with location + feature scoring
 * - Results persisted to PostgreSQL for follow-up operations
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

/**
 * NOTE: This tool now uses the graph's decomposed property search pipeline
 * instead of the old subgraph invoke pattern.
 */

/**
 * Property Search Tool (ES-based)
 *
 * Uses the property_search_v2 subgraph for hybrid Elasticsearch search.
 * Returns searchId for use with property_get_details and other operations.
 */
export const propertySearchESTool = new DynamicStructuredTool({
  name: "property_search",
  description: `Search for properties using natural language queries.

⚠️ IMPORTANT: This tool returns a searchId that you MUST use for follow-up operations:
- Use the searchId from this tool's response to call property_get_details for full property data
- The searchId is saved in the database and can be used for filtering/sorting operations

WORKFLOW:
1. Call property_search with user's query → get searchId + property count
2. Use searchId to call property_get_details for full details of specific properties

Uses hybrid Elasticsearch search with:
- Location-based scoring (geographic relevance)
- Feature-based scoring (matching amenities, price ranges)
- Combined ranking for best results

The search automatically handles:
- Natural language query parsing (via GPT-4o-mini)
- Geographic entity recognition (cities, neighborhoods, addresses)
- Price range extraction ("under 500k", "between 300k and 600k")
- Feature extraction (bedrooms, bathrooms, pool, waterfront, etc.)
- Deduplication of listings that appear in multiple sources

Examples:
- "2 bedroom condos in Miami under 500k"
- "luxury homes in Aventura"
- "waterfront properties in Miami Beach"
- "3+ bedroom houses in Doral with pool"
- "2651 S Course Dr 307, Pompano Beach, FL, 33069"`,

  schema: z.object({
    query: z
      .string()
      .describe(
        "Natural language property search query (e.g., '2 bedroom condos in Miami under 500k')",
      ),
  }),

  func: async ({ query }, config) => {
    console.log(`[PropertySearchES] DEPRECATED: This tool should not be called.`);
    console.log(`[PropertySearchES] Use: router → query_mapper → search_executor → deduplicator → result_saver → search_response_generator`);

    return JSON.stringify({
      success: false,
      summary: 'This search tool is deprecated. Searches are now handled through the decomposed graph pipeline.',
      totalCount: 0,
      searchId: null,
      error: 'Tool deprecated - use graph pipeline'
    }, null, 2);
  },
});

/**
 * Property Details Tool
 *
 * Get detailed information about a specific property by its ID.
 * This is a placeholder tool that will be implemented when needed.
 */
export const propertyDetailsTool = new DynamicStructuredTool({
  name: "property_details",
  description: "Get detailed information about a specific property by its ID",
  schema: z.object({
    propertyId: z
      .string()
      .describe("The unique ID of the property (e.g., 'prop-001')"),
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
