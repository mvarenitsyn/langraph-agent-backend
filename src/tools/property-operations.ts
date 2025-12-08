/**
 * Property Operations Tools
 *
 * Tools for filtering, sorting, and retrieving property search results
 * using the unified property_search PostgreSQL database.
 *
 * All tools use SQL-based operations for performance and consistency.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import {
  createLimitedResponse,
  formatLimitedResponse,
  TOOL_RESPONSE_LIMITS,
} from "./response-limiter.js";
import {
  getSearchResults as getSearchResultsFromDB,
  getSearchMetadata,
  getPropertyByListingKey,
  markFilteredOut,
} from "../subgraphs/property-search/db/search-results.js";

/**
 * Property Filter/Sort Tool (SQL-Based)
 *
 * Filter and sort property search results using efficient SQL queries.
 * Replaces the previous JS sandbox approach with indexed database queries.
 */
export const propertyFilterSortTool = new DynamicStructuredTool({
  name: "property_filter_sort",
  description: `Filter and sort property search results using predefined operations.

This tool filters and sorts properties from a previous search (by searchId) using
efficient SQL queries. Results are returned immediately and sent to the frontend.

SORTING (sortBy):
- price: Sort by list price
- bedrooms: Sort by bedroom count
- sqft: Sort by living area (square footage)
- combined_score: Sort by relevance/match score (default)
- year_built: Sort by year built

SORT ORDER (sortOrder):
- asc: Ascending (lowest first, oldest first)
- desc: Descending (highest first, newest first) - default

FILTERING:
- minPrice/maxPrice: Filter by price range
- minBeds/maxBeds: Filter by bedroom count
- cities: Filter by city names (array, e.g., ["Miami", "Aventura"])
- status: Filter by listing status (array, e.g., ["Active", "Pending"])

PAGINATION:
- page: Page number (default: 1)
- pageSize: Results per page (default: 20, max: 100)

Examples:
1. "Sort by price, cheapest first":
   sortBy: "price", sortOrder: "asc"

2. "Show 3+ bedroom homes under 500k":
   minBeds: 3, maxPrice: 500000

3. "Only Miami and Aventura properties":
   cities: ["Miami", "Aventura"]

4. "Newest homes first":
   sortBy: "year_built", sortOrder: "desc"

5. "Active listings only, sorted by size":
   status: ["Active"], sortBy: "sqft", sortOrder: "desc"`,

  schema: z.object({
    searchId: z.string().describe("UUID of the search result to filter/sort"),
    sortBy: z
      .enum(["price", "bedrooms", "sqft", "combined_score", "year_built"])
      .optional()
      .describe("Field to sort by (default: combined_score)"),
    sortOrder: z
      .enum(["asc", "desc"])
      .optional()
      .describe(
        "Sort direction: asc (ascending) or desc (descending, default)",
      ),
    minPrice: z.number().optional().describe("Minimum price filter"),
    maxPrice: z.number().optional().describe("Maximum price filter"),
    minBeds: z.number().optional().describe("Minimum bedrooms filter"),
    maxBeds: z.number().optional().describe("Maximum bedrooms filter"),
    cities: z
      .array(z.string())
      .optional()
      .describe("Filter by city names (e.g., ['Miami', 'Aventura'])"),
    status: z
      .array(z.string())
      .optional()
      .describe("Filter by listing status (e.g., ['Active', 'Pending'])"),
    page: z.number().optional().describe("Page number (default: 1)"),
    pageSize: z
      .number()
      .optional()
      .describe("Results per page (default: 20, max: 100)"),
  }),

  func: async (
    {
      searchId,
      sortBy,
      sortOrder,
      minPrice,
      maxPrice,
      minBeds,
      maxBeds,
      cities,
      status,
      page,
      pageSize,
    },
    config,
  ) => {
    console.log(
      `[PropertyFilterSortTool] SQL-based filter/sort for searchId: ${searchId}`,
    );
    console.log(`[PropertyFilterSortTool] Params:`, {
      sortBy,
      sortOrder,
      minPrice,
      maxPrice,
      minBeds,
      maxBeds,
      cities,
      status,
      page,
      pageSize,
    });

    if (!searchId) {
      return JSON.stringify(
        {
          success: false,
          error: "searchId is required",
          suggestion: "Call property_search first to get a searchId",
        },
        null,
        2,
      );
    }

    try {
      const startTime = Date.now();

      // Check if any filter conditions are provided (not just sort)
      const hasFilters =
        minPrice !== undefined ||
        maxPrice !== undefined ||
        minBeds !== undefined ||
        maxBeds !== undefined ||
        (cities && cities.length > 0) ||
        (status && status.length > 0);

      // Persist filters to database for shareable results
      let filterStats: { filteredCount: number; totalCount: number } | null =
        null;
      if (hasFilters) {
        console.log(
          `[PropertyFilterSortTool] Persisting filters for searchId: ${searchId}`,
        );
        filterStats = await markFilteredOut(searchId, {
          minPrice,
          maxPrice,
          minBeds,
          maxBeds,
          cities,
          status,
        });
        console.log(
          `[PropertyFilterSortTool] Filter persisted: ${filterStats.filteredCount} of ${filterStats.totalCount} properties match`,
        );
      }

      // Query results - is_filtered_out = false is applied automatically
      const { results, pageInfo } = await getSearchResultsFromDB({
        searchId,
        sortBy: sortBy || "combined_score",
        sortOrder: sortOrder || "desc",
        // No filters needed here - is_filtered_out column handles it
        page: page || 1,
        pageSize: Math.min(pageSize || 20, 100),
      });

      const executionTime = Date.now() - startTime;
      console.log(
        `[PropertyFilterSortTool] SQL query completed in ${executionTime}ms, returned ${results.length} results`,
      );

      // Apply smart response limiting
      const limitedResponse = createLimitedResponse(
        results,
        searchId,
        executionTime,
        TOOL_RESPONSE_LIMITS,
      );

      return JSON.stringify(
        {
          success: true,
          ...limitedResponse,
          searchId,
          pageInfo,
          // Filter persistence info for shareable results
          isFiltered: hasFilters,
          originalCount: filterStats?.totalCount || pageInfo.totalItems,
          filteredCount: filterStats?.filteredCount || pageInfo.totalItems,
          appliedFilters: {
            sortBy: sortBy || "combined_score",
            sortOrder: sortOrder || "desc",
            minPrice,
            maxPrice,
            minBeds,
            maxBeds,
            cities,
            status,
          },
          source: "elasticsearch",
          note: hasFilters
            ? `Filtered to ${filterStats?.filteredCount} of ${filterStats?.totalCount} properties. Filters persisted for sharing.`
            : `Sorted ${pageInfo.totalItems} properties. Page ${pageInfo.page} of ${pageInfo.totalPages}.`,
        },
        null,
        2,
      );
    } catch (error) {
      console.error("[PropertyFilterSortTool] Error:", error);

      return JSON.stringify(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
          searchId,
          suggestion: "Check searchId and try again",
        },
        null,
        2,
      );
    }
  },
});

/**
 * Property Get Details Tool (ES Database Only)
 *
 * Retrieve detailed information about a specific property.
 * Uses the unified property_search PostgreSQL database.
 */
export const propertyGetDetailsTool = new DynamicStructuredTool({
  name: "property_get_details",
  description: `Get detailed information about a specific property from a search result.

⚠️ PREREQUISITE: You MUST call property_search tool FIRST to get a searchId.
This tool CANNOT work without a valid searchId from a prior search.

WORKFLOW:
1. First call: property_search with user's address/query → get searchId
2. Then call: property_get_details with searchId + listingKey/address → get full details

This tool retrieves FULL property details - perfect for when the user asks about
a specific property.

Use this tool when the user asks about:
- A specific property's details ("Tell me about property A1234567")
- Individual fields ("What year was it built?", "Does it have a pool?")
- Comparing specific properties ("Compare the HOA fees")
- Properties at a specific address ("Details for 123 Ocean Drive")

Property lookup methods:
- listingKey: Fast direct database lookup (preferred)
- address: Fuzzy text matching against all results

Common MLS fields available:
- ListingKey, UnparsedAddress, ListPrice
- BedroomsTotal, BathroomsTotalInteger, LivingArea
- YearBuilt, LotSizeSquareFeet
- PoolYN, WaterfrontYN, GarageSpaces
- AssociationFee, TaxAnnualAmount
- StandardStatus, DaysOnMarket
- Plus 40+ more MLS fields!`,

  schema: z.object({
    searchId: z
      .string()
      .describe("UUID of the search result containing the property"),
    listingKey: z
      .string()
      .optional()
      .describe("Property's ListingKey for direct lookup (preferred method)"),
    address: z
      .string()
      .optional()
      .describe(
        "Property address for fuzzy matching (alternative to listingKey)",
      ),
    fields: z
      .array(z.string())
      .optional()
      .describe(
        "Optional: specific fields to return (e.g., ['YearBuilt', 'PoolYN'])",
      ),
  }),

  func: async ({ searchId, listingKey, address, fields }, config) => {
    console.log(
      `[PropertyGetDetailsTool] Retrieving property for searchId: ${searchId}`,
    );
    console.log(
      `[PropertyGetDetailsTool] ListingKey: ${listingKey || "not provided"}, Address: ${address || "not provided"}`,
    );

    if (!listingKey && !address) {
      return JSON.stringify(
        {
          success: false,
          error: "Either listingKey or address must be provided",
          searchId,
          suggestion:
            "Use property_get_results to see available properties and their ListingKeys",
        },
        null,
        2,
      );
    }

    if (!searchId) {
      return JSON.stringify(
        {
          success: false,
          error: "searchId is required",
          suggestion: "Call property_search first to get a searchId",
        },
        null,
        2,
      );
    }

    try {
      let property = null;

      // Method 1: Direct lookup by listingKey (fast, indexed)
      if (listingKey) {
        console.log(
          `[PropertyGetDetailsTool] Direct lookup by listingKey: ${listingKey}`,
        );
        property = await getPropertyByListingKey(searchId, listingKey);

        if (property) {
          console.log(`[PropertyGetDetailsTool] Found property by listingKey`);
        }
      }

      // Method 2: Fuzzy address search (slower, needs to scan results)
      if (!property && address) {
        console.log(
          `[PropertyGetDetailsTool] Searching by address: ${address}`,
        );
        const { results } = await getSearchResultsFromDB({
          searchId,
          page: 1,
          pageSize: 500,
        });

        const normalizedAddress = address.toLowerCase().trim();
        property = results.find(
          (p: any) =>
            p.address?.toLowerCase().includes(normalizedAddress) ||
            p.UnparsedAddress?.toLowerCase().includes(normalizedAddress),
        );

        if (property) {
          console.log(
            `[PropertyGetDetailsTool] Found property by address fuzzy match`,
          );
        }
      }

      if (!property) {
        // Get sample listing keys for suggestion
        const { results } = await getSearchResultsFromDB({
          searchId,
          page: 1,
          pageSize: 5,
        });
        const sampleKeys = results
          .map((p: any) => p.listingKey)
          .filter(Boolean);

        return JSON.stringify(
          {
            success: false,
            error: listingKey
              ? `Property not found with ListingKey: ${listingKey}`
              : `Property not found matching address: ${address}`,
            searchId,
            availableListings: sampleKeys,
            suggestion:
              "Use property_filter_sort to see all available properties",
          },
          null,
          2,
        );
      }

      // Filter to specific fields if requested
      // Support both camelCase and PascalCase field names
      let propertyData = property;
      if (fields && fields.length > 0) {
        // Create case-insensitive field lookup
        const propertyKeys = Object.keys(property);
        const keyMap = new Map<string, string>();
        for (const key of propertyKeys) {
          keyMap.set(key.toLowerCase(), key);
        }

        propertyData = fields.reduce((acc: any, field: string) => {
          // First try exact match
          if (property[field] !== undefined) {
            acc[field] = property[field];
          } else {
            // Then try case-insensitive match
            const matchedKey = keyMap.get(field.toLowerCase());
            if (matchedKey && property[matchedKey] !== undefined) {
              acc[field] = property[matchedKey];
            }
          }
          return acc;
        }, {});
      }

      return JSON.stringify(
        {
          success: true,
          property: propertyData,
          searchId,
          source: "elasticsearch",
          fieldsReturned: fields || "all",
          note:
            fields && fields.length > 0
              ? `Returned ${fields.length} requested fields`
              : "Full property details returned",
        },
        null,
        2,
      );
    } catch (error) {
      console.error("[PropertyGetDetailsTool] Error:", error);

      return JSON.stringify(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
          searchId,
          suggestion: "Check searchId and try again",
        },
        null,
        2,
      );
    }
  },
});

/**
 * Property Get Results Tool (ES Database Only)
 *
 * Retrieve property search results by searchId.
 * Uses the unified property_search PostgreSQL database.
 */
export const propertyGetResultsTool = new DynamicStructuredTool({
  name: "property_get_results",
  description: `Retrieve property search results by searchId.

This tool fetches search results from the database with pagination support.

IMPORTANT: This tool returns TRUNCATED responses to save LLM context:
- Arrays with ≤20 items: Full essential fields returned
- Arrays with >20 items: Statistics + 20 samples returned
- Maximum response size: ~2500 tokens

Use cases:
- Retrieve results from a previous search
- Check what properties are currently displayed on frontend
- Access search metadata and query information

The response includes:
- Essential property fields (ListingKey, address, price, beds, baths, sqft, city)
- Statistics (price range, bedroom range, city distribution)
- Search metadata (query, timestamps)
- Pagination info (page, pageSize, totalPages)

Frontend always has access to full property data via the same searchId.`,

  schema: z.object({
    searchId: z.string().describe("UUID of the search result to retrieve"),
    page: z.number().optional().describe("Page number (default: 1)"),
    pageSize: z
      .number()
      .optional()
      .describe("Results per page (default: 20, max: 100)"),
  }),

  func: async ({ searchId, page, pageSize }, config) => {
    console.log(
      `[PropertyGetResultsTool] Retrieving searchId: ${searchId}, page: ${page || 1}`,
    );

    if (!searchId) {
      return JSON.stringify(
        {
          success: false,
          error: "searchId is required",
          suggestion: "Call property_search first to get a searchId",
        },
        null,
        2,
      );
    }

    try {
      const { results, pageInfo } = await getSearchResultsFromDB({
        searchId,
        page: page || 1,
        pageSize: Math.min(pageSize || 20, 100),
      });

      // Get metadata for additional context
      const metadata = await getSearchMetadata(searchId);

      if (results.length === 0 && !metadata) {
        return JSON.stringify(
          {
            success: false,
            error: "Search result not found",
            searchId,
            suggestion:
              "The searchId may have expired. Run a new property_search.",
          },
          null,
          2,
        );
      }

      console.log(
        `[PropertyGetResultsTool] Found ${results.length} results (page ${pageInfo.page} of ${pageInfo.totalPages})`,
      );

      // Apply smart response limiting
      const limitedResponse = createLimitedResponse(
        results,
        searchId,
        0,
        TOOL_RESPONSE_LIMITS,
      );

      return JSON.stringify(
        {
          success: true,
          ...limitedResponse,
          searchId,
          query: metadata?.queryText || "Unknown query",
          totalCount: pageInfo.totalItems,
          pageInfo,
          hasMore: pageInfo.page < pageInfo.totalPages,
          source: "elasticsearch",
          createdAt: metadata?.createdAt,
        },
        null,
        2,
      );
    } catch (error) {
      console.error("[PropertyGetResultsTool] Error:", error);

      return JSON.stringify(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
          searchId,
          suggestion: "Check searchId and try again",
        },
        null,
        2,
      );
    }
  },
});
