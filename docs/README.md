# LangGraph Agent Documentation

## Quick Start for Frontend Developers

### 1. Start the Agent

```bash
cd /Users/mikhail/projects/myvista/langraph-agent
npm run dev
```

Server runs on: `http://localhost:3003`

### 2. Try the Demo

Open `demo.html` in your browser (requires agent to be running):

```bash
open docs/demo.html
```

### 3. Read Integration Guide

See `FRONTEND_INTEGRATION.md` for:
- Complete React examples (streaming + non-streaming)
- API documentation
- Code samples
- Error handling

---

## What is This Agent?

A **smart property search assistant** that uses the **RRR Pattern** (Router-Reflect-Retry) to ensure high-quality responses.

### The Problem It Solves

Traditional chatbots often return:
- Hallucinated information
- Incomplete answers
- Irrelevant results

### The Solution: RRR Pattern

```
Query → ROUTER → REFLECT → RETRY (if needed) → RESPONSE
```

**ROUTER**: Calls appropriate tools (property search, web research, etc.)
**REFLECT**: AI evaluates result quality and decides PROCEED/RETRY/ERROR
**RETRY**: If quality is low, tries again with different approach (max 3 times)
**RESPONSE**: Only returns high-quality, verified answers

### Real Example

**User**: "Find properties in Austin under $500k with 3 bedrooms"

**What Happens**:
1. Router calls `property_search` tool
2. Tool returns: No results found
3. Reflect evaluates: "LOW quality, INSUFFICIENT information"
4. Instead of saying "No results" (bad UX), agent retries with alternative approach
5. Final response explains why no results + provides helpful alternatives

---

## Key Features

### 1. Multiple Tools

- **property_search** - Search mockup property database
- **property_details** - Get details on specific properties
- **perplexity_search** - Real web research via Perplexity API
- **perplexity_real_estate_research** - Real estate-specific research

### 2. Persistent Memory

Conversations saved to PostgreSQL. Resume anytime using `threadId`.

### 3. Quality Control

Reflection system ensures responses are:
- Relevant to the query
- Complete and informative
- Factually accurate

### 4. Streaming Support

See live progress as agent works (like ChatGPT):
- Which tool is being called
- Reflection evaluation
- Retry attempts
- Final response generation

---

## API Endpoints

### POST /chat/simple (Non-streaming)

**Request**:
```json
{
  "query": "Find homes in San Francisco",
  "threadId": "user-123"
}
```

**Response**:
```json
{
  "success": true,
  "response": "Here are two properties in San Francisco...",
  "threadId": "user-123",
  "metadata": {
    "reflectionRecommendation": "PROCEED",
    "shouldRetry": false
  }
}
```

### POST /chat (Streaming SSE)

**Request**: Same as above

**Response**: Server-Sent Events stream

```
event: step.start
data: {"nodeName":"router","stepNumber":1}

event: step.end
data: {"nodeName":"router","stepNumber":1,"duration":2341}

event: final
data: {"response":"Here are two properties...","totalSteps":5}
```

### GET /history/:threadId

**Response**:
```json
{
  "success": true,
  "threadId": "user-123",
  "state": {
    "query": "Find homes in San Francisco",
    "finalResponse": "Here are two properties...",
    "toolResults": { ... },
    "reflection": "Quality: HIGH, Completeness: SUFFICIENT",
    "retryCount": 0
  }
}
```

---

## Architecture

### SOLID Principles

- **Single Responsibility**: Each node has one job (route, reflect, retry, generate)
- **Open/Closed**: Tools registry allows adding new tools without modifying core
- **Liskov Substitution**: All tools implement uniform interface
- **Interface Segregation**: Modular, focused APIs
- **Dependency Inversion**: Configuration abstractions (process.env)

### Tech Stack

- **LangGraph v1.0** - State machine workflow orchestration
- **LangChain v1.0** - AI framework and tools
- **OpenAI GPT-4o-mini** - Language model
- **Perplexity API** - Real-time web search
- **PostgreSQL** - Persistent checkpointing
- **Express.js** - REST API server
- **TypeScript** - Type safety

---

## Use Cases

### 1. Property Search Assistant

```javascript
query: "Find 3 bedroom homes in San Francisco under $1.5M"
// Agent searches mockup database, filters by criteria, returns formatted results
```

### 2. Market Research

```javascript
query: "What are the average home prices in Seattle?"
// Agent uses Perplexity to research current market data with citations
```

### 3. Neighborhood Analysis

```javascript
query: "Tell me about the best neighborhoods in Austin for families"
// Agent combines property data with web research for comprehensive answer
```

### 4. Property Details

```javascript
query: "Tell me more about 123 Main St, San Francisco"
// Agent retrieves and formats detailed property information
```

---

## Why Use This Over Simple ChatGPT?

| Feature | ChatGPT | LangGraph Agent |
|---------|---------|-----------------|
| **Property Database** | ❌ No access | ✅ Integrated mockup + real API |
| **Quality Control** | ❌ No verification | ✅ RRR reflection pattern |
| **Retry Logic** | ❌ One shot | ✅ Up to 3 retries on poor quality |
| **Persistent Memory** | ❌ Session-based | ✅ PostgreSQL persistence |
| **Tool Calling** | ✅ Basic | ✅ Advanced with quality validation |
| **Streaming** | ✅ Yes | ✅ Yes + step-by-step progress |
| **Real-time Research** | ❌ Training cutoff | ✅ Perplexity API for current data |

---

## LangGraph Studio (Visual Development)

Start the visual development environment:

```bash
npm run studio
```

Then open: https://smith.langchain.com/studio?baseUrl=http://0.0.0.0:8123

**Features**:
- Visual graph flowchart
- Step-by-step debugging
- State inspection at each node
- Time travel through conversations
- Tool call monitoring

See `LANGGRAPH_STUDIO.md` for complete guide.

---

## Development

### Project Structure

```
langraph-agent/
├── src/
│   ├── graph/          # LangGraph workflow
│   ├── nodes/          # Router, Reflect, Retry, Generate
│   ├── tools/          # Tool implementations
│   │   ├── registry.ts # Central tool registry
│   │   ├── property-search.ts
│   │   └── perplexity-search.ts
│   ├── models/         # OpenAI model factories
│   ├── checkpointer/   # PostgreSQL persistence
│   ├── types/          # State definitions
│   └── server.ts       # Express API server
├── docs/
│   ├── README.md       # This file
│   ├── FRONTEND_INTEGRATION.md
│   └── demo.html       # Interactive demo
├── .env                # Configuration
└── package.json
```

### Environment Variables

```bash
OPENAI_API_KEY=sk-proj-...
OPENAI_MODEL=gpt-4o-mini
PERPLEXITY_API_KEY=pplx-...
DATABASE_URL=postgresql://user:pass@host:5432/db
PORT=3003
NODE_ENV=development
```

---

## Testing

```bash
# Start server
npm run dev

# Test simple endpoint
curl -X POST http://localhost:3003/chat/simple \
  -H "Content-Type: application/json" \
  -d '{"query":"Find homes in San Francisco"}'

# Test streaming
curl -N -X POST http://localhost:3003/chat \
  -H "Content-Type: application/json" \
  -d '{"query":"What are home prices in Seattle?"}'

# Test history
curl http://localhost:3003/history/test-123
```

---

## Next Steps

1. **Open demo.html** - Try it out interactively
2. **Read FRONTEND_INTEGRATION.md** - See React code examples
3. **Copy examples** - Integrate into your frontend app
4. **Customize tools** - Add your own property data sources
5. **Deploy** - Ready for production use

---

## Support

**Location**: `/Users/mikhail/projects/myvista/langraph-agent/`
**Port**: 3003
**Status**: Production-ready

**Questions?** Check the integration guide or test with demo.html first.
