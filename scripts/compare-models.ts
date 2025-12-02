/**
 * Model Comparison Test Script
 *
 * Tests GPT-4o-mini, GPT-3.5-turbo, and GPT-5-nano on the same query
 * to compare speed and quality for query mapping.
 */

import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";

// Same schema as query-mapper.ts
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

const SYSTEM_PROMPT = `You are a query parser for a real estate search system. Your job is to split user queries into logical segments for different search backends.

**CRITICAL: Use null for any field NOT explicitly mentioned in the query. Never use 0 or false as defaults.**

**RULES:**

1. **location** segment:
   - query: Full location text (neighborhoods, areas, streets, building names)
   - cities: Extract city names as array or null if not mentioned
   - postalCodes: Extract ZIP codes as array or null if not mentioned
   - counties: Extract county names if mentioned, otherwise null

2. **features** segment:
   - query: Property features for text search: pool, ocean view, waterfront, renovated, etc.

3. **strict** filters:
   - propertyType: ["Residential"] for sales, ["ResidentialLease"] for rentals
   - propertySubType: "Condominium", "SingleFamilyResidence", "Townhouse", "Apartment"
   - status: "Active" for available, "Closed" for sold, "Pending"
   - minBeds: bedroom count. "3br" = minBeds: 3
   - maxBeds: ONLY set if user says "at most X beds" or range like "2-3br"
   - minPrice/maxPrice: price range (e.g., "under $800k" = maxPrice: 800000)

4. **visual_features**: Colors, aesthetics, materials, style for VECTOR search

5. **other**: Time constraints, special requests

**PROPERTY TYPE MAPPINGS:**
- "condo" → propertySubType: "Condominium"
- "house", "home" → propertySubType: "SingleFamilyResidence"
- "rental", "for rent" → propertyType: ["ResidentialLease"]
- "for sale" or no mention → propertyType: ["Residential"]`;

const MODELS = [
  { name: "gpt-4o-mini", id: "gpt-4o-mini", temperature: 0 },
  { name: "gpt-3.5-turbo", id: "gpt-3.5-turbo", temperature: 0 },
  { name: "gpt-5-nano", id: "gpt-5-nano", temperature: 1 }, // Doesn't support temperature=0
];

const TEST_QUERIES = [
  "3br condo Miami Beach ocean view under 800k",
  "luxury waterfront house Fort Lauderdale 4+ beds with pool",
  "rentals Aventura under $3000 2br modern kitchen",
];

interface TestResult {
  model: string;
  query: string;
  durationMs: number;
  result: z.infer<typeof MappedQuerySchema> | null;
  error?: string;
}

async function testModel(modelConfig: { id: string; temperature: number }, query: string): Promise<TestResult> {
  const startTime = Date.now();

  try {
    const model = new ChatOpenAI({
      model: modelConfig.id,
      temperature: modelConfig.temperature,
    }).withStructuredOutput(MappedQuerySchema);

    const messages = [
      new SystemMessage({ content: SYSTEM_PROMPT }),
      new HumanMessage({ content: `Parse this query: "${query}"` }),
    ];

    const result = await model.invoke(messages);
    const durationMs = Date.now() - startTime;

    return {
      model: modelConfig.id,
      query,
      durationMs,
      result,
    };
  } catch (error) {
    return {
      model: modelConfig.id,
      query,
      durationMs: Date.now() - startTime,
      result: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function printResult(result: TestResult) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Model: ${result.model}`);
  console.log(`Query: "${result.query}"`);
  console.log(`Duration: ${result.durationMs}ms`);

  if (result.error) {
    console.log(`ERROR: ${result.error}`);
    return;
  }

  if (!result.result) {
    console.log("No result");
    return;
  }

  const r = result.result;
  console.log(`\nParsed Output:`);
  console.log(`  Location: ${r.location.query} | Cities: ${JSON.stringify(r.location.cities)}`);
  console.log(`  Features: ${r.features.query}`);
  console.log(`  Visual: ${r.visual_features}`);
  console.log(`  Strict Filters:`);
  console.log(`    - propertyType: ${JSON.stringify(r.strict.propertyType)}`);
  console.log(`    - propertySubType: ${r.strict.propertySubType}`);
  console.log(`    - status: ${r.strict.status}`);
  console.log(`    - beds: ${r.strict.minBeds}-${r.strict.maxBeds}`);
  console.log(`    - price: $${r.strict.minPrice || 0} - $${r.strict.maxPrice || '∞'}`);
  console.log(`    - poolYn: ${r.strict.poolYn}`);
  console.log(`    - waterfrontYn: ${r.strict.waterfrontYn}`);
}

function printSummary(results: TestResult[]) {
  console.log(`\n${"=".repeat(60)}`);
  console.log("SUMMARY - Average Response Time");
  console.log("=".repeat(60));

  const byModel = new Map<string, number[]>();

  for (const r of results) {
    if (!byModel.has(r.model)) byModel.set(r.model, []);
    byModel.get(r.model)!.push(r.durationMs);
  }

  for (const [model, times] of byModel) {
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const errors = results.filter(r => r.model === model && r.error).length;
    console.log(`${model}: ${avg.toFixed(0)}ms avg (${errors} errors)`);
  }
}

async function main() {
  console.log("Model Comparison Test");
  console.log("Testing: GPT-4o-mini, GPT-3.5-turbo, GPT-5-nano");
  console.log(`Queries: ${TEST_QUERIES.length}`);

  const results: TestResult[] = [];

  for (const query of TEST_QUERIES) {
    console.log(`\n\nTesting query: "${query}"`);
    console.log("-".repeat(60));

    // Run all models in parallel for fair comparison
    const modelResults = await Promise.all(
      MODELS.map(m => testModel({ id: m.id, temperature: m.temperature }, query))
    );

    for (const result of modelResults) {
      printResult(result);
      results.push(result);
    }
  }

  printSummary(results);
}

main().catch(console.error);
