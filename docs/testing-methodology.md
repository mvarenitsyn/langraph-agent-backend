# LangGraph Agent Testing Methodology

## Overview

This document describes how to test the Property Search subgraph using LangGraph Studio's API endpoints.

## LangGraph Studio API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/ok` | GET | Health check |
| `/threads` | POST | Create a new conversation thread |
| `/threads/{id}/runs/wait` | POST | Run the graph and wait for result |

## Testing Flow

```
1. POST /threads → get thread_id
2. POST /threads/{thread_id}/runs/wait with:
   - assistant_id (graph identifier from langgraph.json)
   - input.message (user query)
3. Response contains full state:
   - toolResults.mappedQuery (from query-mapper node)
   - toolResults.searchResults (from search-executor node)
   - toolResults.searchStats (counts)
4. Use jq to extract and format specific fields
```

## Quick Test Script

Save as `/tmp/test-property-search.sh`:

```bash
#!/bin/bash
# Test Property Search Pipeline

# Step 1: Create a new thread (conversation session)
THREAD_ID=$(curl -s -X POST 'http://localhost:8123/threads' \
  -H 'Content-Type: application/json' -d '{}' | jq -r '.thread_id')
echo "Thread: $THREAD_ID"

# Step 2: Run the agent and wait for completion
curl -s -X POST "http://localhost:8123/threads/${THREAD_ID}/runs/wait" \
  -H 'Content-Type: application/json' \
  -d '{
    "assistant_id": "5afd02a5-49eb-595f-a079-b7cc69747183",
    "input": {
      "message": "3br condo Miami Beach ocean view under 800k"
    }
  }' | jq '{
    mappedQuery_strict: .toolResults.mappedQuery.strict,
    searchStats: .toolResults.searchStats,
    topResult: (.toolResults.searchResults | if . then .[0] else null end)
  }'
```

**What this tests:**
- Creates a thread → runs the graph → extracts key fields with `jq`
- Shows: query mapping (strict filters), search stats, and top result
- Quick validation that the pipeline works end-to-end

## Detailed Results Test

To check ALL search results (e.g., verify city filtering):

```bash
bash -c 'THREAD_ID=$(curl -s -X POST "http://localhost:8123/threads" \
  -H "Content-Type: application/json" -d "{}" | jq -r ".thread_id"); \
curl -s -X POST "http://localhost:8123/threads/${THREAD_ID}/runs/wait" \
  -H "Content-Type: application/json" \
  -d "{\"assistant_id\": \"5afd02a5-49eb-595f-a079-b7cc69747183\", \
       \"input\": {\"message\": \"3br condo Miami Beach ocean view under 800k\"}}" \
  | jq ".toolResults.searchResults[] | {address, city, price, bedrooms}"'
```

**What this tests:**
- Same flow, but extracts ALL search results
- Specifically checks the `city` field on each result
- Validates exact matching (e.g., Miami Beach vs North Miami Beach)

## Expected Response Structure

```json
{
  "mappedQuery_strict": {
    "propertyType": ["Residential"],
    "propertySubType": "Condominium",
    "status": "Active",
    "minBeds": 3,
    "maxBeds": null,
    "maxPrice": 800000
  },
  "searchStats": {
    "total": 3,
    "locationCount": 5,
    "featureCount": 3
  },
  "topResult": {
    "listingKey": "1045847912",
    "address": "5601 Collins Ave 1514",
    "city": "Miami Beach",
    "price": "700000.00",
    "bedrooms": 3
  }
}
```

## Key Validation Points

1. **Schema Compliance**
   - `propertySubType` should be a single string (not array)
   - `status` should be a single string (not array)
   - `maxBeds` should be `null` unless user explicitly requests a range

2. **Search Results**
   - `locationCount > 0` means ES location search found candidates
   - `featureCount > 0` means ES features search found matches
   - `total` is the combined/filtered result count

3. **City Filtering**
   - Uses `terms` on `city.keyword` for exact matching
   - "Miami Beach" should NOT match "North Miami Beach"

## Finding the Assistant ID

The `assistant_id` is the UUID of the graph registered in LangGraph Studio. You can find it:

1. In LangGraph Studio UI (graph settings)
2. In `langgraph.json` configuration
3. By calling `GET /assistants` endpoint

## Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| `locationCount: 0` | Impossible filters | Check maxBeds isn't less than minBeds |
| Wrong cities in results | Text matching instead of exact | Use `terms` on `city.keyword` |
| `status` as array error | Schema mismatch | Ensure Zod schema uses `z.string()` not `z.array()` |
