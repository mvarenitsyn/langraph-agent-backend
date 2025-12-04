/**
 * Property Sandbox Tools
 *
 * Provides LLM with dynamic property data exploration capabilities:
 * 1. property_discover_fields - Discover available MLS fields
 * 2. property_analyze - Run analysis code on properties
 * 3. property_query - Query properties with custom filter logic
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { getSearchResults } from "../subgraphs/property-search/db/search-results.js";
import {
  analyzeFields,
  categorizeFields,
  getFieldDescription,
} from "./sandbox/field-analyzer.js";
import { executeAnalysis, executeFilter } from "./sandbox/executor.js";
import { sanitizeFieldFilter } from "./sandbox/validators.js";
import {
  createLimitedResponse,
  TOOL_RESPONSE_LIMITS,
} from "./response-limiter.js";

// Maximum properties to load for sandbox operations
const MAX_PROPERTIES_FOR_SANDBOX = 500;

/**
 * Tool 1: Discover available property fields
 *
 * Use this BEFORE writing analysis/query code to know what fields exist.
 */
export const propertyDiscoverFieldsTool = new DynamicStructuredTool({
  name: "property_discover_fields",
  description: `Discover all available property fields from search results.

Returns: Field names, data types, presence rates (% of properties with this field), and sample values.

IMPORTANT: Use this tool BEFORE writing analysis or query code to understand:
- What fields are available in the data
- What type each field is (string, number, boolean, etc.)
- How many properties have each field (presence rate)
- Sample values to understand the data format

Example uses:
- "What fields are available?" → Returns all fields
- "What pool-related fields exist?" → filter: "pool"
- "Show me price fields" → filter: "price"
- "What agent info is available?" → filter: "agent"

The filter parameter accepts simple patterns like:
- "pool" - fields containing "pool"
- "pool|water" - fields containing "pool" OR "water"`,

  schema: z.object({
    searchId: z.string().describe("UUID of the search result to analyze"),
    filter: z
      .string()
      .optional()
      .describe(
        "Optional filter pattern for field names (e.g., 'pool', 'price|cost')",
      ),
    categorize: z
      .boolean()
      .optional()
      .default(false)
      .describe("Group fields by category (location, pricing, features, etc.)"),
  }),

  func: async ({ searchId, filter, categorize }) => {
    console.log(
      `[PropertySandbox] Discovering fields for searchId: ${searchId}, filter: ${filter || "none"}`,
    );
    const startTime = Date.now();

    try {
      // Load properties from database
      const { results, pageInfo } = await getSearchResults({
        searchId,
        pageSize: MAX_PROPERTIES_FOR_SANDBOX,
      });

      if (results.length === 0) {
        return JSON.stringify({
          success: false,
          error: "No properties found for this searchId",
          searchId,
        });
      }

      // Analyze fields
      const filterPattern = sanitizeFieldFilter(filter);
      const fields = analyzeFields(
        results as unknown as Record<string, unknown>[],
        filterPattern,
      );

      // Add descriptions for known fields
      const fieldsWithDescriptions = fields.map((f) => ({
        ...f,
        description: getFieldDescription(f.name),
      }));

      // Build response
      let response: Record<string, unknown>;

      if (categorize) {
        const categorized = categorizeFields(fieldsWithDescriptions);
        response = {
          success: true,
          totalProperties: pageInfo.totalItems,
          propertiesAnalyzed: results.length,
          fieldsFound: fields.length,
          fieldsByCategory: categorized,
          note: filter ? `Filtered by: ${filter}` : "All fields shown",
          executionTimeMs: Date.now() - startTime,
        };
      } else {
        response = {
          success: true,
          totalProperties: pageInfo.totalItems,
          propertiesAnalyzed: results.length,
          fieldsFound: fields.length,
          fields: fieldsWithDescriptions.slice(0, 100), // Limit to 100 fields for LLM
          note: filter
            ? `Filtered by: ${filter}`
            : "Showing top 100 fields by presence rate",
          executionTimeMs: Date.now() - startTime,
        };
      }

      console.log(
        `[PropertySandbox] Found ${fields.length} fields in ${Date.now() - startTime}ms`,
      );
      return JSON.stringify(response);
    } catch (error) {
      console.error("[PropertySandbox] Field discovery error:", error);
      return JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        searchId,
      });
    }
  },
});

/**
 * Tool 2: Analyze property data with code
 *
 * Run aggregation/analysis code on properties in a secure sandbox.
 */
export const propertyAnalyzeTool = new DynamicStructuredTool({
  name: "property_analyze",
  description: `Execute JavaScript code to analyze property data in a secure sandbox.

CONSTRAINTS:
- Timeout: 5 seconds
- Memory: 32MB
- Read-only (cannot modify data)
- No network/file access

AVAILABLE VARIABLES & FUNCTIONS:
- properties: Array of property objects from search results
- sum(field): Sum numeric values of a field
- avg(field): Average numeric values of a field
- min(field): Minimum value of a field
- max(field): Maximum value of a field
- groupBy(field): Group properties by field value → { "Miami": [...], "Aventura": [...] }
- countBy(field): Count by field value → { "Miami": 45, "Aventura": 12 }
- unique(field): Get unique values of a field → ["Miami", "Aventura", ...]
- filter(fn): Filter properties with a function

EXAMPLES:
1. Average price:
   code: "avg('ListPrice')"

2. Count by city:
   code: "countBy('City')"

3. Price range:
   code: "({ min: min('ListPrice'), max: max('ListPrice'), avg: avg('ListPrice') })"

4. Average price per sqft by city:
   code: \`
     const groups = groupBy('City');
     const result = {};
     for (const [city, props] of Object.entries(groups)) {
       const avgPpsf = props
         .filter(p => p.ListPrice && p.LivingArea)
         .map(p => p.ListPrice / p.LivingArea)
         .reduce((a, b, i, arr) => a + b / arr.length, 0);
       result[city] = Math.round(avgPpsf);
     }
     result
   \`

5. Properties with pools by price range:
   code: \`
     const withPool = properties.filter(p => p.PoolYN === true || p.PoolYN === 'Yes');
     ({
       total: withPool.length,
       under500k: withPool.filter(p => p.ListPrice < 500000).length,
       under1m: withPool.filter(p => p.ListPrice < 1000000).length,
       over1m: withPool.filter(p => p.ListPrice >= 1000000).length
     })
   \`

NOTE: Use property_discover_fields first to see what fields are available!`,

  schema: z.object({
    searchId: z.string().describe("UUID of the search result to analyze"),
    code: z.string().describe("JavaScript expression or code block to execute"),
  }),

  func: async ({ searchId, code }) => {
    console.log(
      `[PropertySandbox] Analyzing with code for searchId: ${searchId}`,
    );
    const startTime = Date.now();

    try {
      // Load properties
      const { results, pageInfo } = await getSearchResults({
        searchId,
        pageSize: MAX_PROPERTIES_FOR_SANDBOX,
      });

      if (results.length === 0) {
        return JSON.stringify({
          success: false,
          error: "No properties found for this searchId",
          searchId,
        });
      }

      console.log(
        `[PropertySandbox] Loaded ${results.length} properties, executing analysis...`,
      );

      // Execute in sandbox
      const execResult = await executeAnalysis(
        code,
        results as unknown as Record<string, unknown>[],
      );

      if (!execResult.success) {
        return JSON.stringify({
          success: false,
          error: execResult.error,
          searchId,
          propertiesAnalyzed: results.length,
          executionTimeMs: execResult.executionTimeMs,
        });
      }

      console.log(
        `[PropertySandbox] Analysis completed in ${execResult.executionTimeMs}ms`,
      );

      return JSON.stringify({
        success: true,
        result: execResult.result,
        propertiesAnalyzed: results.length,
        totalProperties: pageInfo.totalItems,
        executionTimeMs: execResult.executionTimeMs,
      });
    } catch (error) {
      console.error("[PropertySandbox] Analysis error:", error);
      return JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        searchId,
        executionTimeMs: Date.now() - startTime,
      });
    }
  },
});

/**
 * Tool 3: Query properties with custom filter logic
 *
 * Run custom JavaScript filter/sort logic on properties.
 */
export const propertyQueryTool = new DynamicStructuredTool({
  name: "property_query",
  description: `Query properties with custom JavaScript filter and sort logic in a secure sandbox.

CONSTRAINTS:
- Timeout: 5 seconds
- Memory: 32MB
- Returns max 20 properties (configurable)
- Read-only access

USE CASES:
- Complex multi-condition filtering that can't be done with property_filter_sort
- Computed field comparisons (e.g., price per sqft)
- Fuzzy matching or pattern-based filtering

FILTER CODE FORMAT:
Write a boolean expression where 'p' is the property object.
Example: "p.BedroomsTotal >= 3 && p.PoolYN && p.ListPrice < 800000"

SORT CODE FORMAT (optional):
Write a comparison expression where 'a' and 'b' are properties.
Return negative if a should come first, positive if b should come first.
Example: "a.ListPrice - b.ListPrice" (ascending by price)
Example: "(a.ListPrice/a.LivingArea) - (b.ListPrice/b.LivingArea)" (by price/sqft)

EXAMPLES:

1. 3+ bed with pool under $800k:
   filterCode: "p.BedroomsTotal >= 3 && p.PoolYN && p.ListPrice < 800000"

2. Under $400/sqft sorted by price per sqft:
   filterCode: "p.ListPrice && p.LivingArea && (p.ListPrice / p.LivingArea) < 400"
   sortCode: "(a.ListPrice/a.LivingArea) - (b.ListPrice/b.LivingArea)"

3. Waterfront properties in specific cities:
   filterCode: "p.WaterfrontYN && ['Miami', 'Miami Beach', 'Aventura'].includes(p.City)"
   sortCode: "b.ListPrice - a.ListPrice"

4. Recently built (2015+) with 2+ car garage:
   filterCode: "p.YearBuilt >= 2015 && p.GarageSpaces >= 2"

5. Properties with specific text in remarks:
   filterCode: "p.PublicRemarks && p.PublicRemarks.toLowerCase().includes('renovated')"

RETURNS: Matching properties (limited) plus statistics about the query.

NOTE: Use property_discover_fields first to see what fields are available!`,

  schema: z.object({
    searchId: z.string().describe("UUID of the search result to query"),
    filterCode: z
      .string()
      .describe("JavaScript filter expression: p => <boolean condition>"),
    sortCode: z
      .string()
      .optional()
      .describe("Optional JavaScript sort expression: (a, b) => <comparison>"),
    limit: z
      .number()
      .optional()
      .default(20)
      .describe("Maximum properties to return (default: 20, max: 50)"),
  }),

  func: async ({ searchId, filterCode, sortCode, limit }) => {
    console.log(
      `[PropertySandbox] Querying with filter for searchId: ${searchId}`,
    );
    const startTime = Date.now();

    // Enforce limit
    const effectiveLimit = Math.min(limit || 20, 50);

    try {
      // Load properties
      const { results, pageInfo } = await getSearchResults({
        searchId,
        pageSize: MAX_PROPERTIES_FOR_SANDBOX,
      });

      if (results.length === 0) {
        return JSON.stringify({
          success: false,
          error: "No properties found for this searchId",
          searchId,
        });
      }

      console.log(
        `[PropertySandbox] Loaded ${results.length} properties, executing query...`,
      );

      // Execute filter in sandbox
      const execResult = await executeFilter(
        filterCode,
        results as unknown as Record<string, unknown>[],
        sortCode,
        effectiveLimit,
      );

      if (!execResult.success) {
        return JSON.stringify({
          success: false,
          error: execResult.error,
          searchId,
          propertiesSearched: results.length,
          executionTimeMs: execResult.executionTimeMs,
        });
      }

      const matchingProperties = execResult.result || [];
      console.log(
        `[PropertySandbox] Query found ${matchingProperties.length} matching properties in ${execResult.executionTimeMs}ms`,
      );

      // Use response limiter for output
      const limitedResponse = createLimitedResponse(
        matchingProperties,
        searchId,
        execResult.executionTimeMs,
        {
          ...TOOL_RESPONSE_LIMITS,
          maxProperties: effectiveLimit,
        },
      );

      return JSON.stringify({
        ...limitedResponse,
        query: {
          filterCode,
          sortCode: sortCode || null,
          limit: effectiveLimit,
        },
        propertiesSearched: results.length,
        totalInSearch: pageInfo.totalItems,
        matchCount: matchingProperties.length,
      });
    } catch (error) {
      console.error("[PropertySandbox] Query error:", error);
      return JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        searchId,
        executionTimeMs: Date.now() - startTime,
      });
    }
  },
});

// Export all tools
export const propertySandboxTools = [
  propertyDiscoverFieldsTool,
  propertyAnalyzeTool,
  propertyQueryTool,
];
