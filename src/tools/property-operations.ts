/**
 * Property Operations Tools
 *
 * Tools for filtering, sorting, and retrieving property search results
 * with smart response truncation to prevent LLM context overflow.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import https from "https";
import {
  createLimitedResponse,
  formatLimitedResponse,
  TOOL_RESPONSE_LIMITS
} from "./response-limiter.js";

/**
 * Property Filter/Sort Tool
 *
 * Execute custom JavaScript code to filter, sort, or transform property search results.
 * Results are saved to database and published to frontend via Pub/Sub.
 *
 * IMPORTANT: This tool returns limited data (<2500 tokens) to save LLM context.
 * Full results are always saved to the database and available to the frontend.
 */
export const propertyFilterSortTool = new DynamicStructuredTool({
  name: "property_filter_sort",
  description: `Execute JavaScript code to filter, sort, or transform property search results.

This tool loads properties from a previous search (by searchId) and executes custom
JavaScript code against them. Results are saved to the database and sent to the frontend.

CRITICAL: This tool returns TRUNCATED responses to save LLM context:
- Arrays with ≤20 items: Full essential fields returned
- Arrays with >20 items: Statistics + 20 samples returned
- Non-arrays: Returned if <10KB, otherwise preview + stats
- Maximum response size: ~2500 tokens

Full results are ALWAYS:
1. Saved to database (filtered_results column)
2. Published via Pub/Sub to frontend
3. Displayed on map/listview immediately

Available in JavaScript context:
- properties: Array of Property objects
- console: Safe console object (log, error, warn)
- Math, Date, JSON: Standard JavaScript objects
- Array methods: filter, map, reduce, sort, slice, etc.

Common examples:

1. Filter by price:
   return properties.filter(p => p.ListPrice < 500000)

2. Sort by price:
   return properties.sort((a, b) => a.ListPrice - b.ListPrice)

3. Filter + sort:
   return properties
     .filter(p => p.BedroomsTotal >= 3)
     .sort((a, b) => a.ListPrice - b.ListPrice)

4. Calculate statistics:
   const prices = properties.map(p => p.ListPrice)
   return {
     min: Math.min(...prices),
     max: Math.max(...prices),
     avg: prices.reduce((sum, p) => sum + p, 0) / prices.length
   }

5. Group by city:
   return properties.reduce((acc, p) => {
     const city = p.City || 'Unknown'
     if (!acc[city]) acc[city] = []
     acc[city].push(p)
     return acc
   }, {})

Property fields available:
- ListingKey: Unique property ID
- UnparsedAddress: Full address
- ListPrice: List price
- BedroomsTotal: Number of bedrooms
- BathroomsTotalInteger: Number of bathrooms
- LivingArea: Square footage
- City, StateOrProvince: Location
- Plus 50+ other MLS fields (see Trestle API docs)

The tool returns a summary with essential fields only. Frontend displays full results.`,

  schema: z.object({
    searchId: z.string().optional().describe("UUID of the search result to filter/sort. OPTIONAL - will be auto-injected from active search session if not provided."),
    code: z.string().describe("JavaScript code to execute. MUST return a value (use 'return' statement). Available context: properties array, console, Math, Date, JSON."),
    saveResults: z.boolean().default(true).describe("Whether to save filtered results to database and send to frontend (default: true)")
  }),

  func: async ({ searchId, code, saveResults }, config) => {
    console.log(`[PropertyFilterSortTool] Executing code for searchId: ${searchId}`);
    console.log(`[PropertyFilterSortTool] Code length: ${code.length} characters`);
    console.log(`[PropertyFilterSortTool] Save results: ${saveResults}`);

    // Extract sessionId and userId from config metadata (injected by custom ToolNode)
    const sessionId = (config as any)?.metadata?.sessionId;
    const userId = (config as any)?.metadata?.userId;

    console.log(`[PropertyFilterSortTool] Using sessionId: ${sessionId}, userId: ${userId}`);

    try {
      // Create HTTPS agent that bypasses SSL verification for localhost
      const httpsAgent = new https.Agent({
        rejectUnauthorized: false,
      });

      const apiUrl = 'https://localhost:3001';
      const endpoint = `${apiUrl}/api/search-results/${searchId}/execute`;

      console.log(`[PropertyFilterSortTool] Calling: ${endpoint}`);

      // Make API request to sandbox execution endpoint
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          code,
          filterResults: saveResults,  // Save to filtered_results column
          timeout: 10000,  // 10 second timeout
        }),
        // @ts-ignore - Node.js fetch supports agent option
        agent: httpsAgent,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API returned ${response.status}: ${errorText}`);
      }

      const data = await response.json() as any;

      // Handle execution errors
      if (!data.success) {
        console.error('[PropertyFilterSortTool] Execution failed:', data.error);

        return JSON.stringify({
          success: false,
          error: data.error?.message || 'Unknown error',
          errorCode: data.error?.code || 'EXECUTION_ERROR',
          searchId,
          note: 'Code execution failed. Check syntax and try again.',
        }, null, 2);
      }

      console.log(`[PropertyFilterSortTool] Execution successful in ${data.executionTimeMs}ms`);
      console.log(`[PropertyFilterSortTool] Result type: ${Array.isArray(data.data) ? `array[${data.data.length}]` : typeof data.data}`);

      // Apply smart response limiting
      const limitedResponse = createLimitedResponse(
        data.data,
        searchId,
        data.executionTimeMs,
        TOOL_RESPONSE_LIMITS
      );

      // Add success flag and preserve metadata
      const response_with_success = {
        success: true,
        ...limitedResponse,
        metadata: data.metadata  // Preserve originalCount and other metadata
      };

      return formatLimitedResponse(response_with_success);

    } catch (error) {
      console.error('[PropertyFilterSortTool] Error:', error);

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      return JSON.stringify({
        success: false,
        error: errorMessage,
        searchId,
        note: 'Failed to execute filter/sort operation. Check searchId and try again.',
      }, null, 2);
    }
  },
});

/**
 * Property Get Details Tool
 *
 * Retrieve detailed information about a specific property without truncation.
 * Use this when user asks about a specific property by ListingKey or address.
 */
export const propertyGetDetailsTool = new DynamicStructuredTool({
  name: "property_get_details",
  description: `Get detailed information about a specific property from a search result.

This tool retrieves FULL property details without truncation - perfect for when
the user asks about a specific property.

Use this tool when the user asks about:
- A specific property's details ("Tell me about property A1234567")
- Individual fields ("What year was it built?", "Does it have a pool?")
- Comparing specific properties ("Compare the HOA fees")
- Properties at a specific address ("Details for 123 Ocean Drive")

Unlike property_filter_sort which returns truncated responses, this tool:
- Returns ALL property fields (50+ MLS fields) by default
- No token truncation for single property (~500-800 tokens)
- Can filter to specific fields only to reduce response size
- Fast lookup by ListingKey (exact match) or address (fuzzy match)

Common MLS fields available:
Basic Info:
  - ListingKey: Unique property ID
  - UnparsedAddress: Full address
  - ListPrice: List price
  - BedroomsTotal, BathroomsTotalInteger: Bed/bath count

Size & Construction:
  - LivingArea: Square footage
  - LotSizeSquareFeet: Lot size
  - YearBuilt: Year built

Features & Amenities:
  - PoolYN: Has pool (true/false)
  - WaterfrontYN: Waterfront property (true/false)
  - GarageSpaces: Number of garage spaces
  - FireplacesTotal: Number of fireplaces

Financial:
  - AssociationFee: Monthly HOA fee
  - TaxAnnualAmount: Annual property taxes

Listing Info:
  - StandardStatus: Active, Pending, Sold, etc.
  - DaysOnMarket: Days listed
  - ListingContractDate: When listed

Plus 40+ more MLS fields!

To find a property's ListingKey, first use property_get_results to see available properties.`,

  schema: z.object({
    searchId: z.string().optional().describe("UUID of the search result containing the property. OPTIONAL - will be auto-injected from active search session if not provided."),
    listingKey: z.string().optional().describe("Property's ListingKey for exact match (preferred method)"),
    address: z.string().optional().describe("Property address for fuzzy matching (alternative to listingKey)"),
    fields: z.array(z.string()).optional().describe("Optional: specific fields to return (e.g., ['YearBuilt', 'PoolYN']). If omitted, returns ALL fields.")
  }),

  func: async ({ searchId, listingKey, address, fields }, config) => {
    console.log(`[PropertyGetDetailsTool] Retrieving property details for searchId: ${searchId}`);
    console.log(`[PropertyGetDetailsTool] ListingKey: ${listingKey || 'not provided'}`);
    console.log(`[PropertyGetDetailsTool] Address: ${address || 'not provided'}`);
    console.log(`[PropertyGetDetailsTool] Fields: ${fields ? fields.join(', ') : 'all fields'}`);

    // Validate that at least one identifier is provided
    if (!listingKey && !address) {
      return JSON.stringify({
        success: false,
        error: 'Either listingKey or address must be provided',
        searchId,
        suggestion: 'Use property_get_results to see available properties and their ListingKeys'
      }, null, 2);
    }

    // Extract sessionId and userId from config metadata (injected by custom ToolNode)
    const sessionId = (config as any)?.metadata?.sessionId;
    const userId = (config as any)?.metadata?.userId;

    console.log(`[PropertyGetDetailsTool] Using sessionId: ${sessionId}, userId: ${userId}`);

    try {
      // Create HTTPS agent that bypasses SSL verification for localhost
      const httpsAgent = new https.Agent({
        rejectUnauthorized: false,
      });

      const apiUrl = 'https://localhost:3001';
      const endpoint = `${apiUrl}/api/search-results/${searchId}`;

      console.log(`[PropertyGetDetailsTool] Fetching search results from: ${endpoint}`);

      // Fetch search results to access properties
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
        // @ts-ignore - Node.js fetch supports agent option
        agent: httpsAgent,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API returned ${response.status}: ${errorText}`);
      }

      const result = await response.json() as any;

      if (!result.success || !result.data) {
        console.error('[PropertyGetDetailsTool] API error:', result.error);

        return JSON.stringify({
          success: false,
          error: result.error?.message || 'Search result not found',
          searchId,
          suggestion: 'Use property_search to create a new search first'
        }, null, 2);
      }

      const searchResult = result.data;
      const properties = searchResult.properties || [];

      console.log(`[PropertyGetDetailsTool] Loaded ${properties.length} properties`);

      if (properties.length === 0) {
        return JSON.stringify({
          success: false,
          error: 'Search result contains no properties',
          searchId,
          suggestion: 'Try a different search query'
        }, null, 2);
      }

      // Find the specific property
      let property = null;

      // Priority 1: Exact match by ListingKey
      if (listingKey) {
        property = properties.find((p: any) => p.ListingKey === listingKey);
        console.log(`[PropertyGetDetailsTool] ListingKey exact match: ${property ? 'found' : 'not found'}`);
      }

      // Priority 2: Fuzzy match by address
      if (!property && address) {
        const normalizedAddress = address.toLowerCase().trim();
        property = properties.find((p: any) =>
          p.UnparsedAddress?.toLowerCase().includes(normalizedAddress)
        );
        console.log(`[PropertyGetDetailsTool] Address fuzzy match: ${property ? 'found' : 'not found'}`);
      }

      // Property not found
      if (!property) {
        // Get sample ListingKeys for helpful error message
        const sampleKeys = properties.slice(0, 5).map((p: any) => p.ListingKey).filter(Boolean);

        return JSON.stringify({
          success: false,
          error: listingKey
            ? `Property not found with ListingKey: ${listingKey}`
            : `Property not found matching address: ${address}`,
          searchId,
          availableListings: sampleKeys,
          totalProperties: properties.length,
          suggestion: 'Use property_get_results to see all available properties and their ListingKeys'
        }, null, 2);
      }

      console.log(`[PropertyGetDetailsTool] Property found: ${property.UnparsedAddress}`);

      // Filter to specific fields if requested
      let propertyData = property;
      if (fields && fields.length > 0) {
        propertyData = fields.reduce((acc: any, field: string) => {
          if (property[field] !== undefined) {
            acc[field] = property[field];
          }
          return acc;
        }, {});

        console.log(`[PropertyGetDetailsTool] Filtered to ${fields.length} fields`);
      }

      // Return full property details (no truncation)
      return JSON.stringify({
        success: true,
        property: propertyData,
        searchId,
        fieldsReturned: fields || 'all',
        note: fields && fields.length > 0
          ? `Returned ${fields.length} requested fields`
          : 'Full property details returned (all 50+ MLS fields, no truncation)'
      }, null, 2);

    } catch (error) {
      console.error('[PropertyGetDetailsTool] Error:', error);

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      return JSON.stringify({
        success: false,
        error: errorMessage,
        searchId,
        suggestion: 'Check searchId and try again'
      }, null, 2);
    }
  },
});

/**
 * Property Get Results Tool
 *
 * Retrieve full search results (including filtered results) by searchId.
 * Returns truncated response to LLM, full data available to frontend.
 */
export const propertyGetResultsTool = new DynamicStructuredTool({
  name: "property_get_results",
  description: `Retrieve property search results by searchId.

This tool fetches a search result from the database, including both original
properties and any filtered results that were saved via property_filter_sort.

IMPORTANT: This tool returns TRUNCATED responses to save LLM context:
- Arrays with ≤20 items: Full essential fields returned
- Arrays with >20 items: Statistics + 20 samples returned
- Maximum response size: ~2500 tokens

Use cases:
- Retrieve results from a previous search
- Get filtered results that were saved earlier
- Check what properties are currently displayed on frontend
- Access search metadata and query information

The response includes:
- Essential property fields (ListingKey, address, price, beds, baths, sqft, city)
- Statistics (price range, bedroom range, city distribution)
- Search metadata (query, filters, timestamps)
- Filtered results if available

Frontend always has access to full property data via the same searchId.`,

  schema: z.object({
    searchId: z.string().optional().describe("UUID of the search result to retrieve. OPTIONAL - will be auto-injected from active search session if not provided."),
    includeFiltered: z.boolean().default(true).describe("Whether to include filtered results if available (default: true)")
  }),

  func: async ({ searchId, includeFiltered }, config) => {
    console.log(`[PropertyGetResultsTool] Retrieving searchId: ${searchId}`);
    console.log(`[PropertyGetResultsTool] Include filtered: ${includeFiltered}`);

    // Extract sessionId and userId from config metadata (injected by custom ToolNode)
    const sessionId = (config as any)?.metadata?.sessionId;
    const userId = (config as any)?.metadata?.userId;

    console.log(`[PropertyGetResultsTool] Using sessionId: ${sessionId}, userId: ${userId}`);

    try {
      // Create HTTPS agent that bypasses SSL verification for localhost
      const httpsAgent = new https.Agent({
        rejectUnauthorized: false,
      });

      const apiUrl = 'https://localhost:3001';
      const endpoint = `${apiUrl}/api/search-results/${searchId}`;

      console.log(`[PropertyGetResultsTool] Calling: ${endpoint}`);

      // Make API request to get search results
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
        // @ts-ignore - Node.js fetch supports agent option
        agent: httpsAgent,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API returned ${response.status}: ${errorText}`);
      }

      const result = await response.json() as any;

      // Handle API errors
      if (!result.success || !result.data) {
        console.error('[PropertyGetResultsTool] API error:', result.error);

        return JSON.stringify({
          success: false,
          error: result.error?.message || 'Search result not found',
          errorCode: result.error?.code || 'NOT_FOUND',
          searchId,
          note: 'Search result not found. Check searchId and try again.',
        }, null, 2);
      }

      const searchResult = result.data;

      console.log(`[PropertyGetResultsTool] Found search result:`);
      console.log(`  - Query: ${searchResult.query}`);
      console.log(`  - Original properties: ${searchResult.properties?.length || 0}`);
      console.log(`  - Has filtered results: ${!!searchResult.filteredResults}`);

      // Determine which properties to return
      let propertiesToReturn = searchResult.properties || [];
      let isFiltered = false;

      if (includeFiltered && searchResult.filteredResults) {
        // Use filtered results if available
        propertiesToReturn = Array.isArray(searchResult.filteredResults)
          ? searchResult.filteredResults
          : searchResult.properties || [];
        isFiltered = Array.isArray(searchResult.filteredResults);
      }

      // Apply smart response limiting
      const limitedResponse = createLimitedResponse(
        propertiesToReturn,
        searchId,
        0, // No execution time for GET
        TOOL_RESPONSE_LIMITS
      );

      // Add metadata
      const response_with_metadata = {
        success: true,
        ...limitedResponse,
        query: searchResult.query,
        totalFound: searchResult.totalFound,
        hasMore: searchResult.hasMore,
        isFiltered,
        originalCount: searchResult.properties?.length || 0,
        filteredCount: isFiltered ? propertiesToReturn.length : null,
        createdAt: searchResult.createdAt,
        updatedAt: searchResult.updatedAt
      };

      return formatLimitedResponse(response_with_metadata);

    } catch (error) {
      console.error('[PropertyGetResultsTool] Error:', error);

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      return JSON.stringify({
        success: false,
        error: errorMessage,
        searchId,
        note: 'Failed to retrieve search results. Check searchId and try again.',
      }, null, 2);
    }
  },
});
