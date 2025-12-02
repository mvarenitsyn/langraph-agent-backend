# Property Search V2 Mini-Agent Architecture

## Implementation Plan

### File Structure
```
src/
├── subagents/
│   └── property-search/
│       ├── graph.ts          # Subagent graph definition
│       ├── state.ts          # Subagent-specific state
│       └── nodes/
│           └── query-mapper.ts
```

### LangGraph Studio Setup
Add to langgraph.json:
```json
{
  "graphs": {
    "agent": "./src/graph/index.ts:createAgentGraph",
    "property_search_v2": "./src/subagents/property-search/graph.ts:createPropertySearchGraph"
  }
}
```

### State (subagent-specific)
```typescript
PropertySearchState {
  query: string                    // User input
  mappedQuery: {
    address: { query, filters }    // ES: address index
    features: { query, filters }   // ES: features index
    visual_features: string        // VECTOR search
    other: string                  // Everything else
  }
}
```

---

## Entry Condition (when integrated)

Main agent router decides: shouldSearchProperties = true

## Nodes

### 1. property_search_v2 (entry node)
- Entry point for property search queries
- Receives: user message + conversation history from main agent
- Called when router determines query is property-search related

## Tools

### 1. query_mapper
Splits user query into logical segments:

#### address (ES index: address)
- query: location info EXCEPT city/zip (street, neighborhood, building name)
- filters: city, zip code (strict)

#### features (ES index: features)
- query: property features (water view, heated pool, wooden floor)
- filters: optional

#### visual_features (VECTOR SEARCH - separate from features)
- colors
- abstract: modern, minimalistic, materials
- look/aesthetic
- uses embedding similarity, NOT Elasticsearch

#### extended_features
- TBD (details coming)

## Branch Decision (after query_mapper)

### ADD branch
- expand search area
- relax filters
- add filters that increase results
- triggers: search_pipeline

### REDUCE branch
- narrow down results
- stricter filters
- remove filter values
- triggers: sandbox tool (works with existing data)

## Tools

### 2. search_pipeline (ADD branch)
Orchestrates 4 separate tools:

#### 2a. address_search (ES)
- input: { query, filters }
- ES index: address

#### 2b. features_search (ES)
- input: { query, filters }
- ES index: features

#### 2c. visual_search (VECTOR)
- input: query
- vector similarity search

#### 2d. extended_features_search
- TBD (details coming)

### 3. aggregation
- receives results from all 4 search tools
- combines/intersects listing_keys
- produces unified result set
- bi-directional connection with sandbox

### 4. sandbox (REDUCE branch)
- works with existing search results
- applies stricter filtering logic
- no new search needed
- bi-directional connection with aggregation (reads data, writes filtered results)

## Flow

router (main agent) --[shouldSearchProperties]--> property_search_v2 --> query_mapper
