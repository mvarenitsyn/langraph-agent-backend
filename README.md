# LangGraph Agent Boilerplate

A production-ready, independent LangGraph agent with tools registry, persistent PostgreSQL checkpointing, RRR pattern (Router-Reflect-Retry), streaming support, and OpenAI integration.

## Features

✅ **Tools Registry System** - Centralized tool management with dynamic registration
✅ **RRR Pattern** - Router-Reflect-Retry for quality control and self-correction
✅ **Persistent Memory** - PostgreSQL checkpointing for conversation state
✅ **Streaming Support** - Real-time OnStep messages via Server-Sent Events
✅ **OpenAI Integration** - Pre-configured models module with credentials
✅ **Property Search** - Mockup tool for property searches
✅ **Perplexity API** - Real web search implementation
✅ **TypeScript** - Fully typed with strict mode
✅ **Express Server** - RESTful API with health checks

## Quick Start

### 1. Installation

```bash
cd agents/langraph-boilerplate
npm install
```

### 2. Environment Setup

Copy the example environment file and configure your credentials:

```bash
cp .env.example .env
```

Edit `.env` with your API keys:

```env
OPENAI_API_KEY=your_openai_api_key_here
PERPLEXITY_API_KEY=your_perplexity_api_key_here
DATABASE_URL=postgresql://user:password@localhost:5432/langraph_checkpoints
PORT=3002
```

### 3. Database Setup

Create and initialize the PostgreSQL database:

```bash
# Create database
createdb langraph_checkpoints

# Run setup script
npm run setup-db
```

### 4. Start the Server

Development mode with hot reload:
```bash
npm run dev
```

Production mode:
```bash
npm run build
npm start
```

The server will start on `http://localhost:3002`

## API Endpoints

### POST /chat (Streaming)

Real-time streaming chat with OnStep events.

```bash
curl -X POST http://localhost:3002/chat \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Find 3 bedroom homes in San Francisco under $1.5M",
    "threadId": "user-123"
  }'
```

### POST /chat/simple (Non-Streaming)

Standard request-response chat.

```bash
curl -X POST http://localhost:3002/chat/simple \
  -H "Content-Type: application/json" \
  -d '{
    "query": "What are the latest real estate trends in Oakland?",
    "threadId": "user-123"
  }'
```

Response:
```json
{
  "success": true,
  "response": "...",
  "threadId": "user-123",
  "metadata": {...}
}
```

### GET /history/:threadId

Retrieve conversation history for a specific thread.

```bash
curl http://localhost:3002/history/user-123
```

### GET /health

Health check endpoint.

```bash
curl http://localhost:3002/health
```

## Architecture

### RRR Pattern (Router-Reflect-Retry)

The agent uses a three-stage pattern for quality control:

1. **Router** - Routes queries to appropriate tools and executes them
2. **Reflect** - Analyzes results for quality and completeness
3. **Retry** - Decides whether to retry or proceed to response generation

```
START → router → reflect → retry → [router OR generate_response] → END
                              ↑            ↓
                              └────────────┘
                              (retry loop)
```

### Tools Registry

All tools are managed through a centralized registry:

```typescript
import { globalToolsRegistry } from './tools/registry.js';

// Register a tool
globalToolsRegistry.register(myTool);

// Get all tools
const tools = globalToolsRegistry.getAllTools();

// Get specific tool
const tool = globalToolsRegistry.getTool('property_search');
```

### Available Tools

1. **property_search** - Search for properties by location, price, bedrooms
2. **property_details** - Get detailed information about a property
3. **perplexity_search** - Web search using Perplexity AI
4. **perplexity_real_estate_research** - Real estate market research

### Persistent Checkpointing

Conversations are persisted to PostgreSQL with thread-based isolation:

```typescript
// Each user gets their own thread
const threadId = `user-${userId}`;

// State is automatically checkpointed after each step
const result = await graph.invoke(input, {
  configurable: { thread_id: threadId }
});

// Retrieve conversation history
const state = await graph.getState({
  configurable: { thread_id: threadId }
});
```

### Streaming Events

The agent emits real-time events during execution:

- `step.start` - Node execution started
- `step.end` - Node execution completed
- `tool.start` - Tool invocation started
- `tool.end` - Tool invocation completed
- `reflection.start` - Reflection analysis started
- `reflection.end` - Reflection analysis completed
- `error` - Error occurred
- `final` - Final response ready

## Project Structure

```
agents/langraph-boilerplate/
├── src/
│   ├── checkpointer/          # PostgreSQL checkpointing
│   │   ├── index.ts
│   │   └── setup-db.ts
│   ├── config/                # Configuration management
│   │   └── index.ts
│   ├── graph/                 # LangGraph definition
│   │   └── index.ts
│   ├── models/                # OpenAI models module
│   │   └── openai.ts
│   ├── nodes/                 # Graph nodes (RRR pattern)
│   │   ├── router.ts
│   │   ├── reflect.ts
│   │   ├── retry.ts
│   │   └── generate-response.ts
│   ├── tools/                 # Tools and registry
│   │   ├── registry.ts
│   │   ├── property-search.ts
│   │   ├── perplexity-search.ts
│   │   └── index.ts
│   ├── types/                 # TypeScript types
│   │   ├── state.ts
│   │   └── events.ts
│   ├── utils/                 # Utilities
│   │   └── streaming.ts
│   └── server.ts              # Express server
├── config/                    # Config files (if needed)
├── examples/                  # Example usage
├── .env.example               # Environment template
├── package.json
├── tsconfig.json
└── README.md
```

## Example Usage

### Property Search

```bash
curl -X POST http://localhost:3002/chat/simple \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Show me 2-3 bedroom condos in San Francisco under $1M",
    "threadId": "user-123"
  }'
```

### Market Research

```bash
curl -X POST http://localhost:3002/chat/simple \
  -H "Content-Type: application/json" \
  -d '{
    "query": "What are the current housing market trends in Oakland?",
    "threadId": "user-123"
  }'
```

### Continue Conversation

```bash
# First message
curl -X POST http://localhost:3002/chat/simple \
  -H "Content-Type: application/json" \
  -d '{"query": "Find homes in Berkeley", "threadId": "user-456"}'

# Follow-up (uses same threadId)
curl -X POST http://localhost:3002/chat/simple \
  -H "Content-Type: application/json" \
  -d '{"query": "What about 4 bedrooms?", "threadId": "user-456"}'
```

## Adding Custom Tools

Create a new tool file in `src/tools/`:

```typescript
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

export const myCustomTool = new DynamicStructuredTool({
  name: "my_custom_tool",
  description: "Description of what this tool does",
  schema: z.object({
    param1: z.string().describe("First parameter"),
    param2: z.number().optional().describe("Second parameter"),
  }),
  func: async ({ param1, param2 }) => {
    // Tool implementation
    return JSON.stringify({ result: "..." });
  },
});
```

Register it in `src/tools/index.ts`:

```typescript
import { myCustomTool } from "./my-custom-tool.js";

export function initializeTools() {
  // ... existing tools
  globalToolsRegistry.register(myCustomTool);
}
```

## Configuration

All configuration is in `src/config/index.ts`:

```typescript
export const config = {
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-4o',
    temperature: 0.7,
  },
  perplexity: {
    apiKey: process.env.PERPLEXITY_API_KEY,
  },
  database: {
    url: process.env.DATABASE_URL,
  },
  agent: {
    maxRetries: 3,
  },
};
```

## Testing

```bash
npm test
```

## Production Considerations

1. **Rate Limiting** - Add rate limiting middleware for production
2. **Authentication** - Implement auth middleware for securing endpoints
3. **Monitoring** - Add logging and monitoring (e.g., Winston, Datadog)
4. **Error Handling** - Enhance error handling and recovery
5. **Scaling** - Use load balancer and multiple instances
6. **Database** - Use managed PostgreSQL (e.g., AWS RDS, Supabase)
7. **API Keys** - Use secrets manager (AWS Secrets Manager, HashiCorp Vault)

## Troubleshooting

### Database Connection Issues

```bash
# Check PostgreSQL is running
pg_isready

# Test connection
psql $DATABASE_URL

# Re-run setup
npm run setup-db
```

### OpenAI API Errors

- Verify API key is correct in `.env`
- Check account has credits
- Ensure model name is valid (e.g., 'gpt-4o')

### Port Already in Use

Change the port in `.env`:
```env
PORT=3003
```

## License

MIT

## Contributing

This is a boilerplate template. Feel free to fork and customize for your needs!
