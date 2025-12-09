/**
 * Property Get Full Details Tool
 *
 * Fetch complete property data including raw MLS JSON for property details view.
 * This tool performs a direct PostgreSQL query to fetch the full raw_data JSONB.
 *
 * Performance: ~50ms per property (lazy loading pattern)
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { Pool } from "pg";

export const propertyGetFullDetailsTool = new DynamicStructuredTool({
  name: "property_get_full_details",
  description: `Fetch complete property details including full MLS data for a single property.

⚠️ IMPORTANT: Use this tool ONLY when:
- User explicitly requests full property details
- User clicks on a property to view details
- Frontend requests complete property information

This tool fetches the full 50KB raw MLS JSON data and should NOT be used for:
- Search results (use property_search or property_get_results instead)
- Bulk property information
- Listing comparisons (unless user explicitly requests full details)

The response includes:
- All normalized columns (address, price, beds, baths, etc.)
- Full raw MLS JSON data (Media, Remarks, ListAgent*, etc.)
- Latitude/Longitude coordinates

Example use cases:
1. "Show me full details for listing ABC123"
2. User clicks property card → fetch full details
3. "What's the full description for this property?"
4. "Details for 123 Ocean Drive, Miami Beach"`,

  schema: z.object({
    listingKey: z
      .string()
      .optional()
      .describe(
        "The ListingKey/MLS number of the property (e.g., 'A11696203', 'RX-11030975')",
      ),
    address: z
      .string()
      .optional()
      .describe(
        "Property address for lookup (e.g., '123 Ocean Drive, Miami Beach'). Use when listingKey is not known.",
      ),
  }),

  func: async ({ listingKey, address }, config) => {
    console.log(
      `[PropertyGetFullDetailsTool] Fetching full details for listingKey: ${listingKey || 'not provided'}, address: ${address || 'not provided'}`,
    );

    if (!listingKey && !address) {
      return JSON.stringify(
        {
          success: false,
          error: "Either listingKey or address must be provided",
          suggestion: "Provide a listingKey (e.g., 'A11696203') or an address (e.g., '123 Ocean Drive, Miami Beach')",
        },
        null,
        2,
      );
    }

    try {
      const pool = new Pool({
        host: process.env.TRESTLE_PG_HOST || "34.61.254.83",
        port: 5432,
        database: "property_search",
        user: "postgres",
        password:
          process.env.TRESTLE_PG_PASSWORD || "C2Plq6bqGZpu23sHOOd57Ocb4",
      });

      const start = Date.now();

      let result;

      if (listingKey) {
        // Direct lookup by listingKey (fast, indexed)
        result = await pool.query(
          `
          SELECT
            tp.listing_key,
            tp.unparsed_address,
            tp.city,
            tp.state_or_province as state,
            tp.postal_code,
            tp.list_price,
            tp.bedrooms_total,
            tp.bathrooms_total_integer as bathrooms_total,
            tp.living_area,
            tp.standard_status,
            tp.property_type,
            tp.property_sub_type,
            tp.year_built,
            tp.latitude,
            tp.longitude,
            tp.raw_data
          FROM trestle_properties tp
          WHERE tp.listing_key = $1
        `,
          [listingKey],
        );
      } else {
        // Address-based lookup using full-text search
        console.log(`[PropertyGetFullDetailsTool] Searching by address: ${address}`);
        result = await pool.query(
          `
          SELECT
            tp.listing_key,
            tp.unparsed_address,
            tp.city,
            tp.state_or_province as state,
            tp.postal_code,
            tp.list_price,
            tp.bedrooms_total,
            tp.bathrooms_total_integer as bathrooms_total,
            tp.living_area,
            tp.standard_status,
            tp.property_type,
            tp.property_sub_type,
            tp.year_built,
            tp.latitude,
            tp.longitude,
            tp.raw_data,
            similarity(LOWER(unparsed_address), LOWER($1)) as addr_sim
          FROM trestle_properties tp
          WHERE LOWER(unparsed_address) LIKE '%' || LOWER($1) || '%'
             OR similarity(LOWER(unparsed_address), LOWER($1)) > 0.3
          ORDER BY addr_sim DESC
          LIMIT 1
        `,
          [address],
        );
      }

      const fetchTime = Date.now() - start;

      if (result.rows.length === 0) {
        const searchParam = listingKey ? `ListingKey: ${listingKey}` : `address: ${address}`;
        return JSON.stringify(
          {
            success: false,
            error: `Property not found with ${searchParam}`,
            suggestion: listingKey
              ? "Check the ListingKey and try again, or use property_search to find properties"
              : "Try a more specific address with unit number, or use property_search to find similar properties",
          },
          null,
          2,
        );
      }

      const row = result.rows[0];

      // Merge raw_data with normalized fields and inject lat/lon
      const fullProperty = {
        ...row.raw_data,
        // Override with normalized columns for consistency
        ListingKey: row.listing_key,
        UnparsedAddress: row.unparsed_address,
        City: row.city,
        StateOrProvince: row.state,
        PostalCode: row.postal_code,
        ListPrice: row.list_price,
        BedroomsTotal: row.bedrooms_total,
        BathroomsTotalInteger: row.bathrooms_total,
        LivingArea: row.living_area,
        StandardStatus: row.standard_status,
        PropertyType: row.property_type,
        PropertySubType: row.property_sub_type,
        YearBuilt: row.year_built,
        Latitude: row.latitude,
        Longitude: row.longitude,
      };

      const dataSize = Math.round(JSON.stringify(fullProperty).length / 1024);

      console.log(
        `[PropertyGetFullDetailsTool] ✓ Fetched full details in ${fetchTime}ms (~${dataSize}KB)`,
      );

      return JSON.stringify(
        {
          success: true,
          property: fullProperty,
          listingKey: row.listing_key,
          fetchTimeMs: fetchTime,
          dataSize: `~${dataSize}KB`,
          note: "Full MLS data returned including Media, Remarks, and all agent information",
        },
        null,
        2,
      );
    } catch (error) {
      console.error("[PropertyGetFullDetailsTool] Error:", error);

      return JSON.stringify(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
          listingKey,
          suggestion: "Check database connection and try again",
        },
        null,
        2,
      );
    }
  },
});
