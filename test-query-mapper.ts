/**
 * Isolated Query Mapper Performance Test
 *
 * Tests the LLM call performance separately from the rest of the search flow
 */

import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { z } from "zod";

// Copy of MappedQuerySchema from query-mapper.ts
const MappedQuerySchema = z.object({
  location: z.object({
    query: z.string(),
    cities: z.array(z.string()).nullable(),
    postalCodes: z.array(z.string()).nullable(),
    counties: z.array(z.string()).nullable(),
  }),
  features: z.object({
    query: z.string(),
  }),
  strict: z.object({
    propertyType: z.array(z.string()).nullable(),
    propertySubType: z.string().nullable(),
    status: z.string().nullable(),
    minBeds: z.number().nullable(),
    maxBeds: z.number().nullable(),
    minBaths: z.number().nullable(),
    maxBaths: z.number().nullable(),
    minPrice: z.number().nullable(),
    maxPrice: z.number().nullable(),
    minSqft: z.number().nullable(),
    maxSqft: z.number().nullable(),
    minYearBuilt: z.number().nullable(),
    maxYearBuilt: z.number().nullable(),
    poolYn: z.boolean().nullable(),
    waterfrontYn: z.boolean().nullable(),
    garageYn: z.boolean().nullable(),
    newConstructionYn: z.boolean().nullable(),
  }),
  visual_features: z.string(),
  other: z.string(),
});

// HUGE system prompt (170 lines!)
const CURRENT_SYSTEM_PROMPT = `You are a query parser for a real estate search system. Your job is to split user queries into logical segments for different search backends.

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

[... 150 more lines of neighborhood mappings, examples, etc ...]`;

// Simplified system prompt
const SIMPLE_SYSTEM_PROMPT = `Parse real estate queries into structured search parameters.

Extract:
- location.cities: City names as array
- location.query: Buildings/neighborhoods (NOT cities)
- features.query: Amenities/features (pool, ocean view, etc.)
- strict.propertySubType: "Condominium", "SingleFamilyResidence", "Townhouse", etc.
- strict.minBeds/maxBeds: Exact bedroom count (e.g. "2br" → minBeds:2, maxBeds:2)
- strict.maxPrice/minPrice: Price range in dollars
- strict.status: "Active" (default), "Pending", or "Closed"

Use null for unmentioned fields. No defaults.`;

async function testQueryMapper(userQuery: string, useSimple: boolean = false) {
  const model = new ChatOpenAI({
    model: "gpt-4o-mini",
    temperature: 0,
    streaming: false,
  }).withStructuredOutput(MappedQuerySchema);

  const systemPrompt = useSimple ? SIMPLE_SYSTEM_PROMPT : CURRENT_SYSTEM_PROMPT;

  console.log(`\n${'='.repeat(80)}`);
  console.log(`Testing: "${userQuery}"`);
  console.log(`Prompt: ${useSimple ? 'SIMPLE' : 'CURRENT'} (~${systemPrompt.length} chars)`);
  console.log('='.repeat(80));

  const messages = [
    new SystemMessage({ content: systemPrompt }),
    new HumanMessage({ content: `Parse this query: "${userQuery}"` }),
  ];

  const start = Date.now();
  const result = await model.invoke(messages);
  const elapsed = Date.now() - start;

  console.log(`\n✓ LLM Response Time: ${elapsed}ms`);
  console.log('\nParsed Query:');
  console.log(JSON.stringify(result, null, 2));

  return { elapsed, result };
}

async function runTests() {
  const testQueries = [
    "condos in Hollywood Beach",
    "3br condo Miami Beach ocean view under 800k",
    "2-bedroom apartment in Aventura",
  ];

  console.log('\n🔬 QUERY MAPPER PERFORMANCE TEST');
  console.log('='.repeat(80));

  for (const query of testQueries) {
    // Test with current (huge) prompt
    const current = await testQueryMapper(query, false);

    // Test with simple prompt
    const simple = await testQueryMapper(query, true);

    console.log(`\n📊 COMPARISON FOR: "${query}"`);
    console.log(`   Current Prompt: ${current.elapsed}ms`);
    console.log(`   Simple Prompt:  ${simple.elapsed}ms`);
    console.log(`   Speed Improvement: ${Math.round(((current.elapsed - simple.elapsed) / current.elapsed) * 100)}%`);
    console.log('-'.repeat(80));
  }
}

runTests().catch(console.error);
