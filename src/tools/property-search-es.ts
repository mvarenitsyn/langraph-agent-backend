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
import { invokePropertySearch } from "../subgraphs/property-search/invoke.js";

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
    console.log(`[PropertySearchES] Searching: "${query}"`);

    // Extract sessionId, userId, and userContext from config metadata
    const sessionId = (config as any)?.metadata?.sessionId;
    const userId = (config as any)?.metadata?.userId;
    const userContext = (config as any)?.metadata?.userContext || {
      isAuthenticated: false,
    };
    const correlationId = (config as any)?.metadata?.correlationId;

    const userName = userContext.fullName || "Guest";
    const isAuthenticated = userContext.isAuthenticated || false;

    console.log(
      `[PropertySearchES] User: ${userName} (authenticated=${isAuthenticated})`,
    );
    console.log(`[PropertySearchES] SessionId: ${sessionId || "none"}`);
    console.log(`[PropertySearchES] UserId: ${userId || "none"}`);

    // Generate threadId for database persistence
    const threadId = sessionId || correlationId || `search-${Date.now()}`;

    try {
      // Invoke the ES subgraph
      const result = await invokePropertySearch(query, {
        threadId,
        userId,
        sessionId,
        correlationId,
      });

      // Handle errors
      if (result.error) {
        console.error(`[PropertySearchES] Search error: ${result.error}`);
        return JSON.stringify(
          {
            success: false,
            summary: `Search failed: ${result.error}. Try simplifying your search criteria.`,
            totalCount: 0,
            searchId: null,
            mapLink: null,
            error: result.error,
          },
          null,
          2,
        );
      }

      // Build summary message
      const summary = result.summary;
      const parts: string[] = [];

      if (result.totalCount === 0) {
        parts.push(
          `No properties found matching "${query}". Try adjusting your search criteria.`,
        );
      } else {
        parts.push(
          `Found ${result.totalCount} ${result.totalCount === 1 ? "property" : "properties"} matching "${query}".`,
        );

        // Add duplicates removed info if any
        if (summary.duplicatesRemoved > 0) {
          parts.push(
            `(${summary.duplicatesRemoved} duplicate listings removed)`,
          );
        }

        // Add top cities
        if (summary.topCities && summary.topCities.length > 0) {
          parts.push(`\nTop cities: ${summary.topCities.join(", ")}`);
        }

        // Add price range
        if (
          summary.priceRange &&
          summary.priceRange.min !== null &&
          summary.priceRange.max !== null
        ) {
          const minPrice = summary.priceRange.min.toLocaleString();
          const maxPrice = summary.priceRange.max.toLocaleString();
          parts.push(`Price range: $${minPrice} - $${maxPrice}`);
        }

        // Add bedroom range
        if (
          summary.bedroomRange &&
          summary.bedroomRange.min !== null &&
          summary.bedroomRange.max !== null
        ) {
          parts.push(
            `Bedrooms: ${summary.bedroomRange.min} - ${summary.bedroomRange.max}`,
          );
        }

        parts.push(`\n(Properties are now displayed on the interactive map)`);
      }

      console.log(
        `[PropertySearchES] ✓ Search completed with ${result.totalCount} results, searchId: ${result.searchId}`,
      );

      return JSON.stringify(
        {
          success: true,
          summary: parts.join("\n"),
          totalCount: result.totalCount,
          searchId: result.searchId,
          pageInfo: result.pageInfo,
          mapLink: result.searchId
            ? `Properties are now displayed on the interactive map (searchId: ${result.searchId})`
            : null,
          queryMetadata: {
            original: query,
            queryType: "elasticsearch_hybrid",
            intent: null, // ES search doesn't extract intent like backend
          },
        },
        null,
        2,
      );
    } catch (error) {
      console.error("[PropertySearchES] Error:", error);

      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      return JSON.stringify(
        {
          success: false,
          summary: `Search failed: ${errorMessage}. Please try again or contact support if the issue persists.`,
          totalCount: 0,
          searchId: null,
          mapLink: null,
          error: errorMessage,
        },
        null,
        2,
      );
    }
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
