import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { AgentStateType } from "../../../types/state.js";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

/**
 * MappedQuery Schema - Compatible with hybrid-search script
 *
 * Splits user queries into segments for different search backends:
 * - location: ES properties_location index
 * - features: ES properties_features index
 * - strict: All strict filters (price, beds, status, etc.)
 * - visual_features: VECTOR similarity search
 */
const MappedQuerySchema = z.object({
  // Location search → ES properties_location index
  location: z.object({
    query: z.string().describe("Full location text: neighborhoods, areas, streets, building names"),
    cities: z.array(z.string()).nullable().describe("City names for strict filtering, e.g. ['Miami Beach', 'Aventura']"),
    postalCodes: z.array(z.string()).nullable().describe("ZIP codes for strict filtering, e.g. ['33139', '33180']"),
    counties: z.array(z.string()).nullable().describe("County names for strict filtering"),
  }),

  // Features search → ES properties_features index
  features: z.object({
    query: z.string().describe("Feature text for search: pool, ocean view, waterfront, renovated, etc."),
  }),

  // Strict filters (from es-filter-fields.csv) - MUST match hybrid-search.ts schema
  strict: z.object({
    // Term filters (exact match)
    propertyType: z.array(z.string()).nullable().describe("Property type array: ['Residential'], ['ResidentialLease'], etc."),
    propertySubType: z.string().nullable().describe("Single property subtype: 'Condominium', 'SingleFamilyResidence', 'Townhouse', 'Apartment', etc."),
    status: z.string().nullable().describe("Single listing status: 'Active', 'Pending', or 'Closed'"),

    // Range filters - BEDROOM RULES: "2-bedroom" or "2br" means EXACTLY 2 bedrooms (minBeds=2, maxBeds=2)
    minBeds: z.number().nullable().describe("Minimum bedrooms. For '2br' or '2-bedroom': minBeds=2. For '2+ beds': minBeds=2"),
    maxBeds: z.number().nullable().describe("Maximum bedrooms. For '2br' or '2-bedroom': maxBeds=2 (EXACT match). For '2+ beds': maxBeds=null. For '2-3br': maxBeds=3"),
    minBaths: z.number().nullable().describe("Minimum bathrooms"),
    maxBaths: z.number().nullable().describe("Maximum bathrooms"),
    minPrice: z.number().nullable().describe("Minimum price in dollars"),
    maxPrice: z.number().nullable().describe("Maximum price in dollars"),
    minSqft: z.number().nullable().describe("Minimum square feet"),
    maxSqft: z.number().nullable().describe("Maximum square feet"),
    minYearBuilt: z.number().nullable().describe("Minimum year built"),
    maxYearBuilt: z.number().nullable().describe("Maximum year built"),

    // Boolean filters
    poolYn: z.boolean().nullable().describe("Has private pool"),
    waterfrontYn: z.boolean().nullable().describe("Is waterfront property"),
    garageYn: z.boolean().nullable().describe("Has garage"),
    newConstructionYn: z.boolean().nullable().describe("Is new construction"),
  }),

  // VECTOR similarity search
  visual_features: z.string().describe("Visual/aesthetic attributes: colors, modern, minimalistic, materials, style - for VECTOR search"),

  // Everything else
  other: z.string().describe("Anything else that doesn't fit above: time constraints, special requests"),
});

type MappedQuery = z.infer<typeof MappedQuerySchema>;

/**
 * Query Mapper Node - Hybrid Search Compatible
 *
 * Splits user query into segments for different search backends:
 * - location: { query, cities, postalCodes, counties } → ES location index
 * - features: { query } → ES features index
 * - strict: { beds, baths, price, status, etc. } → ES filters
 * - visual_features: string → VECTOR similarity search
 *
 * Example:
 * Input: "3br condo Miami Beach ocean view modern kitchen under $800k"
 * Output:
 * {
 *   location: { query: "Miami Beach", cities: ["Miami Beach"], ... },
 *   features: { query: "ocean view" },
 *   strict: { propertySubType: ["Condominium"], minBeds: 3, maxPrice: 800000, ... },
 *   visual_features: "modern kitchen",
 *   other: ""
 * }
 */
export async function queryMapperNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.log(`\n[QueryMapper] Processing message: "${state.message}"`);

  const userQuery = state.message;

  if (!userQuery || userQuery.trim() === '') {
    console.log('[QueryMapper] Empty query, returning default mapping');
    const emptyMapping: MappedQuery = {
      location: { query: '', cities: null, postalCodes: null, counties: null },
      features: { query: '' },
      strict: {
        propertyType: null, propertySubType: null, status: null,
        minBeds: null, maxBeds: null, minBaths: null, maxBaths: null,
        minPrice: null, maxPrice: null, minSqft: null, maxSqft: null,
        minYearBuilt: null, maxYearBuilt: null,
        poolYn: null, waterfrontYn: null, garageYn: null, newConstructionYn: null,
      },
      visual_features: '',
      other: '',
    };
    return {
      toolResults: { mappedQuery: emptyMapping },
      finalResponse: 'Please provide a property search query.',
    };
  }

  try {
    const model = new ChatOpenAI({
      model: "gpt-4o-mini",
      temperature: 0,
      streaming: false,  // Prevent structured output from being streamed to frontend
    }).withStructuredOutput(MappedQuerySchema);

    const systemPrompt = `You are a query parser for a real estate search system. Your job is to split user queries into logical segments for different search backends.

**CRITICAL: Use null for any field NOT explicitly mentioned in the query. Never use 0 or false as defaults.**

**RULES:**

1. **location** segment:
   - query: ONLY for address/neighborhood/building text searches that are NOT city names. Examples:
     * Building names: "Mystic Pointe", "Portofino Tower", "Jade Signature"
     * Neighborhoods: "South Beach", "Brickell", "Wynwood"
     * Streets: "Collins Ave", "Ocean Drive"
     * Areas: "near the beach", "downtown area"
     * NEVER put city names here (use cities array instead)
   - cities: Extract city names as array (e.g., ["Miami Beach", "Fort Lauderdale"]) or null if not mentioned
   - postalCodes: Extract ZIP codes as array (e.g., ["33139", "33180"]) or null if not mentioned
   - counties: Extract county names if mentioned, otherwise null
   - **IMPORTANT**: City names go ONLY in cities array, NOT in query field

2. **features** segment:
   - query: Property features for text search in ES features index:
     * Amenities: "pool", "ocean view", "waterfront", "boat dock", "balcony"
     * Condition: "renovated", "updated", "new appliances"
     * Other searchable features

3. **strict** filters (exact values for ES filtering):
   - propertyType: ["Residential"] for sales, ["ResidentialLease"] for rentals, null if not determinable
   - propertySubType: "Condominium", "SingleFamilyResidence", "Townhouse", "Apartment" (SINGLE STRING, not array), null if not mentioned
   - status: "Active" for available, "Closed" for sold, "Pending" (SINGLE STRING, not array), null if not mentioned
   - minBeds: bedroom count. "3br" or "3-bedroom" = minBeds: 3
   - maxBeds: Set to SAME value as minBeds for exact bedroom requests. "3br" = maxBeds: 3. "2-bedroom" = maxBeds: 2. ONLY set to null if user says "2+ beds" or "at least 2".
   - minBaths/maxBaths: bathroom count, null if not mentioned
   - minPrice/maxPrice: price range (e.g., "under $800k" = maxPrice: 800000), null if not mentioned
   - minSqft/maxSqft: square footage range, null if not mentioned
   - minYearBuilt/maxYearBuilt: year built range, null if not mentioned
   - poolYn: true ONLY if "pool" or "with pool" explicitly mentioned, otherwise null
   - waterfrontYn: true ONLY if "waterfront" explicitly mentioned, otherwise null
   - garageYn: true ONLY if "garage" explicitly mentioned, otherwise null
   - newConstructionYn: true ONLY if "new construction" explicitly mentioned, otherwise null

4. **visual_features** segment (VECTOR search):
   - Colors: "white kitchen", "dark floors"
   - Aesthetics: "modern", "minimalistic", "contemporary", "luxury"
   - Materials: "marble counters", "wooden floors"
   - Style: "bright and airy", "open concept"

5. **other** segment:
   - Time constraints: "available now", "move-in ready"
   - Special requests not fitting above

**PROPERTY TYPE MAPPINGS (Florida MLS specific):**
- "condo", "condominium" → propertySubType: "Condominium"
- "house", "single family", "home" → propertySubType: "SingleFamilyResidence"
- "townhouse", "townhome" → propertySubType: "Townhouse"
- "apartment", "apt" → **IMPORTANT**: In Florida MLS, high-rise building units (like Mystic Pointe, Porsche Tower, etc.) are classified as "Condominium", NOT "Apartment". Only rental-only buildings use "Apartment". So:
  * If user mentions a building name OR is looking for sale → propertySubType: null (let search be flexible)
  * If user explicitly says "rental apartment" → propertySubType: "Apartment" AND propertyType: ["ResidentialLease"]
- "rental", "for rent", "lease" → propertyType: ["ResidentialLease"]
- "for sale", "buy" (or no mention of rental) → propertyType: ["Residential"]

**⚠️ BEDROOM MAPPING - THIS IS THE MOST IMPORTANT RULE ⚠️**

THE DEFAULT IS EXACT MATCHING. When user says "N-bedroom" or "Nbr", they want EXACTLY N bedrooms.
You MUST set BOTH minBeds AND maxBeds to the same number for exact matching.

EXACT MATCH (no plus sign, no range):
- "2-bedroom" → minBeds: 2, maxBeds: 2
- "2br" → minBeds: 2, maxBeds: 2
- "2 bed" → minBeds: 2, maxBeds: 2
- "two bedroom" → minBeds: 2, maxBeds: 2
- "3-bedroom" → minBeds: 3, maxBeds: 3
- "3br" → minBeds: 3, maxBeds: 3
- "4-bedroom" → minBeds: 4, maxBeds: 4

MINIMUM ONLY (plus sign or "at least"):
- "2+ bedroom" → minBeds: 2, maxBeds: null
- "at least 2 beds" → minBeds: 2, maxBeds: null
- "2 or more beds" → minBeds: 2, maxBeds: null

RANGE (two numbers):
- "2-3 bedroom" → minBeds: 2, maxBeds: 3
- "2-3br" → minBeds: 2, maxBeds: 3

❌ COMMON MISTAKE - DO NOT DO THIS:
- "2-bedroom" should NOT produce maxBeds: 3 or maxBeds: null
- "2-bedroom" should NOT be interpreted as "at least 2 bedrooms"
- Always set maxBeds equal to minBeds for exact bedroom requests

**EXAMPLES:**

Query: "3br condo Miami Beach ocean view modern kitchen under $800k"
Result:
- location: { query: "", cities: ["Miami Beach"], postalCodes: null, counties: null }
- features: { query: "ocean view" }
- strict: { propertyType: ["Residential"], propertySubType: "Condominium", status: "Active", minBeds: 3, maxBeds: 3, minBaths: null, maxBaths: null, minPrice: null, maxPrice: 800000, minSqft: null, maxSqft: null, minYearBuilt: null, maxYearBuilt: null, poolYn: null, waterfrontYn: null, garageYn: null, newConstructionYn: null }
- visual_features: "modern kitchen"
- other: ""
Note: "3br" means EXACTLY 3 bedrooms → minBeds: 3, maxBeds: 3. "Miami Beach" is a city → cities array

Query: "3br apartment Mystic Pointe Aventura water view furnished"
Result:
- location: { query: "Mystic Pointe", cities: ["Aventura"], postalCodes: null, counties: null }
- features: { query: "water view furnished" }
- strict: { propertyType: ["Residential"], propertySubType: null, status: "Active", minBeds: 3, maxBeds: 3, minBaths: null, maxBaths: null, minPrice: null, maxPrice: null, minSqft: null, maxSqft: null, minYearBuilt: null, maxYearBuilt: null, poolYn: null, waterfrontYn: null, garageYn: null, newConstructionYn: null }
- visual_features: ""
- other: ""
Note: "3br" = EXACTLY 3 bedrooms. "Mystic Pointe" is building → location.query. "Aventura" is city → cities array. "apartment" with building = propertySubType: null

Query: "luxury waterfront house Fort Lauderdale 4+ beds pool"
Result:
- location: { query: "", cities: ["Fort Lauderdale"], postalCodes: null, counties: null }
- features: { query: "waterfront" }
- strict: { propertyType: ["Residential"], propertySubType: "SingleFamilyResidence", status: "Active", minBeds: 4, maxBeds: null, minBaths: null, maxBaths: null, minPrice: null, maxPrice: null, minSqft: null, maxSqft: null, minYearBuilt: null, maxYearBuilt: null, poolYn: true, waterfrontYn: true, garageYn: null, newConstructionYn: null }
- visual_features: "luxury"
- other: ""

Query: "rentals Aventura under $3000 2br"
Result:
- location: { query: "", cities: ["Aventura"], postalCodes: null, counties: null }
- features: { query: "" }
- strict: { propertyType: ["ResidentialLease"], propertySubType: null, status: "Active", minBeds: 2, maxBeds: 2, minBaths: null, maxBaths: null, minPrice: null, maxPrice: 3000, minSqft: null, maxSqft: null, minYearBuilt: null, maxYearBuilt: null, poolYn: null, waterfrontYn: null, garageYn: null, newConstructionYn: null }
- visual_features: ""
- other: ""
Note: "2br" = EXACTLY 2 bedrooms → minBeds: 2, maxBeds: 2

Query: "condo South Beach with pool"
Result:
- location: { query: "South Beach", cities: ["Miami Beach"], postalCodes: null, counties: null }
- features: { query: "" }
- strict: { propertyType: ["Residential"], propertySubType: "Condominium", status: "Active", minBeds: null, maxBeds: null, minBaths: null, maxBaths: null, minPrice: null, maxPrice: null, minSqft: null, maxSqft: null, minYearBuilt: null, maxYearBuilt: null, poolYn: true, waterfrontYn: null, garageYn: null, newConstructionYn: null }
- visual_features: ""
- other: ""
Note: "South Beach" is a neighborhood (not a city) → location.query. The city is "Miami Beach" → cities array

Query: "2-bedroom condo in Sunny Isles Beach with ocean view"
Result:
- location: { query: "", cities: ["Sunny Isles Beach"], postalCodes: null, counties: null }
- features: { query: "ocean view" }
- strict: { propertyType: ["Residential"], propertySubType: "Condominium", status: "Active", minBeds: 2, maxBeds: 2, minBaths: null, maxBaths: null, minPrice: null, maxPrice: null, minSqft: null, maxSqft: null, minYearBuilt: null, maxYearBuilt: null, poolYn: null, waterfrontYn: null, garageYn: null, newConstructionYn: null }
- visual_features: ""
- other: ""
Note: "2-bedroom" = EXACTLY 2 bedrooms → minBeds: 2, maxBeds: 2. NOT minBeds: 2, maxBeds: 3!`;

    const messages = [
      new SystemMessage({ content: systemPrompt }),
      new HumanMessage({ content: `Parse this query: "${userQuery}"` }),
    ];

    console.log('[QueryMapper] Calling LLM to parse query...');
    const rawMappedQuery = await model.invoke(messages);

    // Normalize output: convert 0 → null for numbers, false → null for booleans
    // IMPORTANT: Default status to "Active" if not specified by user
    const mappedQuery: MappedQuery = {
      ...rawMappedQuery,
      strict: {
        propertyType: rawMappedQuery.strict.propertyType,
        propertySubType: rawMappedQuery.strict.propertySubType,
        status: rawMappedQuery.strict.status || 'Active', // Fallback to Active
        minBeds: rawMappedQuery.strict.minBeds === 0 ? null : rawMappedQuery.strict.minBeds,
        maxBeds: rawMappedQuery.strict.maxBeds === 0 ? null : rawMappedQuery.strict.maxBeds,
        minBaths: rawMappedQuery.strict.minBaths === 0 ? null : rawMappedQuery.strict.minBaths,
        maxBaths: rawMappedQuery.strict.maxBaths === 0 ? null : rawMappedQuery.strict.maxBaths,
        minPrice: rawMappedQuery.strict.minPrice === 0 ? null : rawMappedQuery.strict.minPrice,
        maxPrice: rawMappedQuery.strict.maxPrice === 0 ? null : rawMappedQuery.strict.maxPrice,
        minSqft: rawMappedQuery.strict.minSqft === 0 ? null : rawMappedQuery.strict.minSqft,
        maxSqft: rawMappedQuery.strict.maxSqft === 0 ? null : rawMappedQuery.strict.maxSqft,
        minYearBuilt: rawMappedQuery.strict.minYearBuilt === 0 ? null : rawMappedQuery.strict.minYearBuilt,
        maxYearBuilt: rawMappedQuery.strict.maxYearBuilt === 0 ? null : rawMappedQuery.strict.maxYearBuilt,
        poolYn: rawMappedQuery.strict.poolYn === false ? null : rawMappedQuery.strict.poolYn,
        waterfrontYn: rawMappedQuery.strict.waterfrontYn === false ? null : rawMappedQuery.strict.waterfrontYn,
        garageYn: rawMappedQuery.strict.garageYn === false ? null : rawMappedQuery.strict.garageYn,
        newConstructionYn: rawMappedQuery.strict.newConstructionYn === false ? null : rawMappedQuery.strict.newConstructionYn,
      },
    };

    console.log('[QueryMapper] Mapped query:', JSON.stringify(mappedQuery, null, 2));

    // Build summary for finalResponse
    const parts: string[] = [];
    if (mappedQuery.location.query) parts.push(`Location: ${mappedQuery.location.query}`);
    if (mappedQuery.location.cities?.length) parts.push(`Cities: ${mappedQuery.location.cities.join(', ')}`);
    if (mappedQuery.features.query) parts.push(`Features: ${mappedQuery.features.query}`);
    if (mappedQuery.visual_features) parts.push(`Visual: ${mappedQuery.visual_features}`);

    const strictParts: string[] = [];
    // propertySubType is now a single string, not array
    if (mappedQuery.strict.propertySubType) strictParts.push(`Type: ${mappedQuery.strict.propertySubType}`);
    if (mappedQuery.strict.minBeds) strictParts.push(`${mappedQuery.strict.minBeds}+ beds`);
    if (mappedQuery.strict.maxPrice) strictParts.push(`Max $${mappedQuery.strict.maxPrice.toLocaleString()}`);
    if (mappedQuery.strict.minPrice) strictParts.push(`Min $${mappedQuery.strict.minPrice.toLocaleString()}`);
    // status is now a single string, not array
    if (mappedQuery.strict.status) strictParts.push(`Status: ${mappedQuery.strict.status}`);
    if (strictParts.length) parts.push(`Filters: ${strictParts.join(', ')}`);

    return {
      messages: [new HumanMessage({ content: userQuery })],
      toolResults: { mappedQuery },
      finalResponse: `Query mapped:\n${parts.join('\n')}`,
      metadata: {
        ...state.metadata,
        queryMapped: true,
      },
    };
  } catch (error) {
    console.error('[QueryMapper] Error:', error);
    return {
      error: error instanceof Error ? error.message : 'Query mapper failed',
      finalResponse: 'Failed to parse query. Please try again.',
    };
  }
}
