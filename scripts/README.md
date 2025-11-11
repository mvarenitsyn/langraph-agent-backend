# LangSmith Trace Viewer

TypeScript-based CLI tool for viewing and analyzing LangSmith traces for the LangGraph agent.

## Features

- 📋 **List recent traces** - View recent execution runs with durations
- ❌ **Filter errors** - Show only failed traces for debugging
- 🐌 **Find slow traces** - Identify performance bottlenecks
- 🌳 **Execution tree** - View complete execution hierarchy
- 📊 **Statistics** - Success rates and performance metrics
- 🔍 **Search** - Find traces by query text

## Usage

### Basic Commands

```bash
# List recent traces (default)
npm run trace

# Show only errors
npm run trace -- --errors

# Find traces slower than 10 seconds
npm run trace -- --slow 10

# Show execution tree for a specific run
npm run trace -- --tree <RUN_ID>

# Show project statistics
npm run trace -- --stats

# Search traces by query text
npm run trace -- --search "property"

# Show help
npm run trace -- --help
```

## Examples

### View Recent Traces
```bash
npm run trace
```
Output:
```
🔍 Recent traces from: property-search-langgraph-agent

1. ✅ LangGraph
   ID: d6e97d30-2d70-4286-b2d9-1737aa3dd257
   Duration: 9.48s
   Started: 2025-11-11 02:56:35
   🔗 https://smith.langchain.com/public/d6e97d30-2d70-4286-b2d9-1737aa3dd257/r
```

### Find Performance Issues
```bash
npm run trace -- --slow 5
```
Shows all traces that took longer than 5 seconds to complete.

### Debug Errors
```bash
npm run trace -- --errors
```
Lists all failed traces with error messages and links to detailed traces.

### View Execution Details
```bash
npm run trace -- --tree d6e97d30-2d70-4286-b2d9-1737aa3dd257
```
Shows the complete execution tree including:
- Router node (tool selection and execution)
- Reflect node (quality assessment)
- Retry node (retry decision)
- Generate response node (final response)

### Check Health Metrics
```bash
npm run trace -- --stats
```
Displays:
- Total runs (last 24 hours and 7 days)
- Success/error counts
- Success rate percentage
- Average execution duration

## Configuration

The tool uses environment variables from `.env`:
- `LANGCHAIN_API_KEY` - Your LangSmith API key
- `LANGCHAIN_PROJECT` - Project name (default: property-search-langgraph-agent)

## Comparison: TypeScript vs Python SDKs

Both LangSmith SDKs (TypeScript and Python) have **feature parity**:

| Feature | TypeScript SDK | Python SDK |
|---------|---------------|------------|
| Advanced filtering | ✅ | ✅ |
| Pagination | ✅ | ✅ |
| Tree navigation | ✅ | ✅ |
| Statistics | ✅ | ✅ |
| Type safety | ✅ (Full TypeScript) | ⚠️ (Type hints) |
| Ecosystem | 📦 Node.js | 🐍 Python ML tools |

**Recommendation**: Use TypeScript SDK for this project since the agent is already in TypeScript/Node.js.

## Files

- `trace-viewer.ts` - Main TypeScript trace viewer
- `advanced-trace-viewer.py` - Python equivalent (for comparison)
- `list-traces.cjs` - Simple Node.js trace viewer using REST API

## Links

- [LangSmith Documentation](https://docs.smith.langchain.com/)
- [LangSmith TypeScript SDK](https://github.com/langchain-ai/langsmith-sdk/tree/main/js)
- [Web UI](https://smith.langchain.com/)
