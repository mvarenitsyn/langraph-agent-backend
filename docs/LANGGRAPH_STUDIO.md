# LangGraph Studio Development Guide

## What is LangGraph Studio?

LangGraph Studio is a visual development environment for LangGraph applications. It provides:

- **Visual Graph Visualization** - See your agent's workflow as a flowchart
- **Interactive Debugging** - Step through agent execution node-by-node
- **State Inspection** - View state at each step of execution
- **Live Testing** - Test your agent with different inputs
- **Tool Monitoring** - See which tools are called and their results
- **Time Travel Debugging** - Replay conversations and inspect history

## Quick Start

### 1. Start LangGraph Studio

```bash
npm run studio
```

This will:
- Start the LangGraph API server on `http://localhost:8123`
- Register your agent graph
- Open the Studio UI in your browser

### 2. Open Studio UI

The Studio UI is available at:
```
https://smith.langchain.com/studio?baseUrl=http://0.0.0.0:8123
```

Or visit LangSmith and connect to your local server at `http://localhost:8123`

### 3. Test Your Agent

1. Select the **"agent"** graph from the dropdown
2. Enter a query in the input box:
   - "Find 3 bedroom homes in San Francisco under $1.5M"
   - "What are home prices in Seattle?"
   - "Tell me about the Austin real estate market"
3. Click **Run** and watch the execution flow through the graph

---

## Configuration

The agent is configured in `langgraph.json`:

```json
{
  "dependencies": ["."],
  "graphs": {
    "agent": "./src/graph/index.ts:createAgentGraph"
  },
  "env": ".env"
}
```

### Configuration Options

- **dependencies**: Directories containing your code
- **graphs**: Mapping of graph IDs to their export locations
- **env**: Environment variables file

---

## Visual Graph Structure

When you open Studio, you'll see your agent's RRR pattern visualized:

```
┌─────────┐
│  START  │
└────┬────┘
     │
     ▼
┌─────────┐
│ Router  │ ◄──┐
└────┬────┘    │
     │         │
     ▼         │
┌─────────┐    │
│ Reflect │    │
└────┬────┘    │
     │         │
     ▼         │
┌─────────┐    │
│  Retry  │────┘ (if retry needed)
└────┬────┘
     │
     ▼
┌──────────────┐
│Generate      │
│Response      │
└──────┬───────┘
       │
       ▼
    ┌─────┐
    │ END │
    └─────┘
```

---

## Debugging Workflow

### 1. Router Node

**What to inspect**:
- Which tools were called
- Tool call parameters
- Tool results

**Example State**:
```json
{
  "query": "Find homes in San Francisco",
  "toolResults": {
    "property_search": {
      "success": true,
      "count": 2,
      "results": [...]
    }
  }
}
```

### 2. Reflect Node

**What to inspect**:
- Reflection analysis
- Quality assessment (HIGH/LOW)
- Recommendation (PROCEED/RETRY/ERROR)

**Example State**:
```json
{
  "reflection": "Quality: HIGH, Completeness: SUFFICIENT",
  "metadata": {
    "reflectionRecommendation": "PROCEED"
  }
}
```

### 3. Retry Node

**What to inspect**:
- Retry count
- Should retry decision
- Next node routing

**Example State**:
```json
{
  "retryCount": 0,
  "maxRetries": 3,
  "metadata": {
    "shouldRetry": false
  }
}
```

### 4. Generate Response Node

**What to inspect**:
- Final response content
- Token usage
- Response time

**Example State**:
```json
{
  "finalResponse": "Here are two properties in San Francisco...",
  "messages": [...]
}
```

---

## Advanced Features

### Checkpointing & Time Travel

Studio integrates with PostgreSQL checkpointing:

1. **View Thread History**
   - See all past conversations
   - Inspect state at any point in time
   - Replay conversations

2. **State Snapshots**
   - Each node execution creates a checkpoint
   - Resume from any checkpoint
   - Compare state across executions

### Thread Management

Each conversation has a `thread_id`:
- View all threads in Studio
- Search threads by query
- Inspect thread metadata

### Tool Inspection

Click on any node to see:
- Tool name and description
- Input schema (Zod validation)
- Input arguments
- Output results
- Execution time

---

## Comparison: Studio vs REST API

| Feature | REST API | LangGraph Studio |
|---------|----------|-----------------|
| **Testing** | curl commands | Visual interface |
| **Debugging** | Console logs | Step-by-step execution |
| **State Inspection** | JSON responses | Interactive viewer |
| **Graph Visualization** | ❌ No | ✅ Flowchart diagram |
| **Time Travel** | ❌ No | ✅ Replay conversations |
| **Tool Monitoring** | Logs only | Visual tool calls |

---

## Common Use Cases

### 1. Testing New Tools

When adding a new tool:
1. Start Studio: `npm run studio`
2. Test tool with various inputs
3. Inspect tool results in real-time
4. Verify tool integration works

### 2. Debugging Retry Logic

When reflection triggers retries:
1. Watch the retry loop in graph visualization
2. Inspect reflection reasoning at each iteration
3. See how state changes between retries
4. Verify retry count increments correctly

### 3. Analyzing Response Quality

For quality control testing:
1. Run same query multiple times
2. Compare reflection assessments
3. Check when PROCEED vs RETRY is triggered
4. Validate final response consistency

### 4. Performance Optimization

For speed improvements:
1. View execution time per node
2. Identify slow tools or models
3. Compare different model configurations
4. Monitor token usage

---

## Development Workflow

### Recommended Setup

**Terminal 1**: Run your REST API server
```bash
npm run dev
```
This runs your agent at `http://localhost:3003` for frontend integration.

**Terminal 2**: Run LangGraph Studio
```bash
npm run studio
```
This runs the Studio API at `http://localhost:8123` for visual debugging.

**Benefits**:
- Test API endpoints from frontend
- Debug issues visually in Studio
- Both environments use same PostgreSQL database
- Share conversation history between both

---

## Troubleshooting

### Studio Won't Start

**Problem**: Port 8123 already in use

**Solution**:
```bash
# Kill existing process
lsof -ti:8123 | xargs kill -9

# Or use different port
npx @langchain/langgraph-cli@latest dev --port 8124
```

### Graph Not Found

**Problem**: "Graph 'agent' not registered"

**Solution**: Check `langgraph.json` configuration:
```json
{
  "graphs": {
    "agent": "./src/graph/index.ts:createAgentGraph"
  }
}
```

Ensure the path points to your graph export.

### Environment Variables Not Loading

**Problem**: Tools fail with "API key not configured"

**Solution**: Verify `.env` file exists and is referenced in `langgraph.json`:
```json
{
  "env": ".env"
}
```

### Can't Connect to Studio UI

**Problem**: Studio UI shows "Cannot connect to server"

**Solution**:
1. Verify server is running: `curl http://localhost:8123/ok`
2. Check firewall settings
3. Use `0.0.0.0` instead of `localhost` in baseUrl

---

## Production Deployment

### LangGraph Studio is for Development Only

For production, use:
- **LangGraph Cloud** - Managed hosting
- **Self-hosted API** - Your own infrastructure
- **Serverless** - AWS Lambda, Vercel, etc.

Studio should **never** be deployed to production. It's designed for:
- Local development
- Debugging
- Testing
- Prototyping

---

## Additional Resources

- **LangGraph Docs**: https://langchain-ai.github.io/langgraph/
- **Studio Guide**: https://langchain-ai.github.io/langgraph/tutorials/langgraph-studio/
- **LangSmith**: https://smith.langchain.com/
- **CLI Reference**: https://github.com/langchain-ai/langgraph-cli

---

## Summary

### When to Use LangGraph Studio

✅ **Development**
- Building new features
- Testing agent behavior
- Debugging issues

✅ **Debugging**
- Understanding execution flow
- Inspecting state changes
- Analyzing retry logic

✅ **Testing**
- Validating tool integration
- Quality control testing
- Performance analysis

### When to Use REST API

✅ **Production**
- Frontend integration
- Mobile apps
- External services

✅ **Automation**
- CI/CD pipelines
- Batch processing
- Scheduled tasks

---

## Quick Commands Reference

```bash
# Start REST API server (port 3003)
npm run dev

# Start LangGraph Studio (port 8123)
npm run studio

# Setup PostgreSQL checkpointing
npm run setup-db

# Build for production
npm run build

# Run production server
npm start
```

---

**Studio UI**: https://smith.langchain.com/studio?baseUrl=http://0.0.0.0:8123

**Local API**: http://localhost:8123

**REST API**: http://localhost:3003
