# Property Operations Tools - Testing Guide

## Summary of Implementation

Successfully implemented **3 new tools** for the LangGraph agent with smart token limiting:

1. **property_filter_sort** - Filter/sort/transform properties with JavaScript execution
2. **property_get_results** - Retrieve search results (truncated to ~2500 tokens)
3. **property_get_details** - Get single property details (FULL, no truncation)

Total tools now: **7** (was 4, added 3)

## Tools Registered

```
✓ property_search              - Find properties by natural language query
✓ property_details             - (Legacy) Get property details
✓ property_filter_sort         - NEW: Filter/sort with JavaScript + smart truncation
✓ property_get_results         - NEW: Retrieve search results + smart truncation
✓ property_get_details         - NEW: Get single property (all fields, no truncation)
✓ perplexity_search            - Web search
✓ perplexity_real_estate_research - RE research
```

## Manual Testing Steps

### Step 1: Get a SearchId

```bash
# Create a search via backend API
curl -k -X POST https://localhost:3001/api/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "3 bedroom condos in Aventura under 700k",
    "sessionId": "test-001",
    "userId": "test-user-001"
  }' | jq -r '.data.searchId'
```

Save the searchId (e.g., `abc-123-xyz`)

### Step 2: Test property_get_results (Truncated Response)

```bash
# Get search results with smart truncation
curl -X POST http://localhost:3003/chat/simple \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Get the search results for searchId abc-123-xyz",
    "threadId": "test-001",
    "sessionId": "test-001",
    "userId": "test-user-001"
  }' | jq -r '.response'
```

**Expected**: Returns ~20 properties with essential fields only (~2500 tokens max)

### Step 3: Test property_filter_sort (Small Dataset)

```bash
# Filter to properties under $500k
curl -X POST http://localhost:3003/chat/simple \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Filter the search abc-123-xyz to only show properties under $500k",
    "threadId": "test-001"
  }' | jq -r '.response'
```

**Expected**: Returns filtered properties (if <20, shows all; if >20, shows 20 samples + statistics)

### Step 4: Test property_filter_sort (Large Dataset - Statistics)

```bash
# Calculate statistics
curl -X POST http://localhost:3003/chat/simple \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Calculate the average price by city for search abc-123-xyz",
    "threadId": "test-001"
  }' | jq -r '.response'
```

**Expected**: Returns statistics object (non-array result, no truncation if <10KB)

### Step 5: Test property_get_details by ListingKey

First, get a ListingKey from step 2 or 3, then:

```bash
# Get full details for specific property
curl -X POST http://localhost:3003/chat/simple \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Get all details for property A1234567 in search abc-123-xyz",
    "threadId": "test-001"
  }' | jq -r '.response'
```

**Expected**: Returns ALL 50+ MLS fields for single property (~500-800 tokens, NO truncation)

### Step 6: Test property_get_details by Address

```bash
# Get details by address fuzzy match
curl -X POST http://localhost:3003/chat/simple \
  -H "Content-Type: application/json" \
  -d '{
    "message": "What year was the property at 123 Ocean Drive built? (from search abc-123-xyz)",
    "threadId": "test-001"
  }' | jq -r '.response'
```

**Expected**: Finds property by address, returns YearBuilt field

### Step 7: Test property_get_details with Field Filtering

```bash
# Get specific fields only
curl -X POST http://localhost:3003/chat/simple \
  -H "Content-Type: application/json" \
  -d '{
    "message": "For property A1234567 in search abc-123-xyz, tell me: YearBuilt, PoolYN, WaterfrontYN, AssociationFee",
    "threadId": "test-001"
  }' | jq -r '.response'
```

**Expected**: Returns only the 4 requested fields (~100 tokens)

## Token Budget Verification

Run all tests and check token usage:

| Tool | Expected Tokens | Actual Tokens |
|------|----------------|---------------|
| property_get_results (10 props) | ~800 | ___ |
| property_get_results (100 props) | ~2200 | ___ |
| property_filter_sort (statistics) | ~300 | ___ |
| property_get_details (all fields) | ~700 | ___ |
| property_get_details (4 fields) | ~100 | ___ |

**All should be under 2500 tokens**

## Frontend Integration Test

1. Open browser to frontend (https://localhost:3002)
2. Type: "Find 3 bedroom condos in Aventura under 700k"
3. Wait for results to load on map
4. Type: "Show only properties under $500k"
5. **Expected**: Map refreshes with filtered properties via Pub/Sub event

## Database Verification

```bash
# Check that filtered results were saved
psql postgresql://localhost/trestledb -c "
  SELECT id, query,
    jsonb_array_length(properties) as property_count,
    filtered_results IS NOT NULL as has_filtered
  FROM search_results
  WHERE session_id = 'test-001'
  ORDER BY created_at DESC
  LIMIT 5;
"
```

## Success Criteria

✅ All 7 tools registered successfully
✅ property_filter_sort returns <2500 tokens for 100+ properties
✅ property_get_details returns ALL fields for single property
✅ Filtered results saved to database
✅ Pub/Sub event published on filter
✅ Frontend map updates with filtered properties
✅ ListingKey always included in truncated responses
✅ Error handling works (invalid searchId, property not found)

## Files Created/Modified

### New Files (2):
- `src/tools/response-limiter.ts` (238 lines)
- `src/tools/property-operations.ts` (542 lines)

### Modified Files (5):
- `src/tools/index.ts` (+3 lines)
- `src/tools/property-search.ts` (TypeScript fixes)
- `src/controllers/SandboxController.ts` (+28 lines - Pub/Sub)
- `src/services/socketService.ts` (+58 lines - filtered event)

### Total: 780 new lines, 89 modified lines

## Next Steps

1. Run manual tests above to verify functionality
2. Test with real user conversations in frontend
3. Monitor token usage in production
4. Consider adding more example code snippets to tool descriptions
5. Add performance metrics logging

## Common Issues

**Issue**: Agent doesn't use property_get_details
**Solution**: Make sure query mentions "details", "tell me about", or specific property ID

**Issue**: Filtered results not showing on map
**Solution**: Check Pub/Sub event was published and frontend received it

**Issue**: Token limits still too high
**Solution**: Reduce maxProperties in TOOL_RESPONSE_LIMITS (currently 20)

**Issue**: Property not found by address
**Solution**: Address matching is fuzzy - try using ListingKey instead
