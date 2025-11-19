#!/bin/bash

# Direct curl testing for LangGraph Agent
# This script demonstrates how to test the agent without using the browser/frontend
#
# The agent has fallback defaults that make testing easy:
# - searchId: 088d4b7f-016b-480f-abd5-92d5b9cca85f (real searchId with 50 properties)
# - userId: 12345678
# - sessionId: auto-generated test session
# - userContext: Test User with authentication

echo "==================================="
echo "LangGraph Agent Direct Test (curl)"
echo "==================================="
echo ""

# Test 1: Follow-up filter query with explicit searchId in metadata
echo "📝 Test 1: Follow-up filter query (searchId: 088d4b7f-016b-480f-abd5-92d5b9cca85f)"
echo "Query: 'Keep properties only under 4000'"
echo ""

curl -X POST http://localhost:3003/chat/simple \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Keep properties only under 4000",
    "threadId": "test-thread-123",
    "metadata": {
      "searchId": "088d4b7f-016b-480f-abd5-92d5b9cca85f",
      "userId": "12345678"
    }
  }' | python3 -m json.tool

echo ""
echo "==================================="
echo ""

# Test 2: Different filter with metadata
echo "📝 Test 2: Follow-up with 3 bedroom filter"
echo "Query: 'Show me 3 bedroom properties'"
echo ""

curl -X POST http://localhost:3003/chat/simple \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Show me 3 bedroom properties",
    "threadId": "test-thread-456",
    "metadata": {
      "searchId": "088d4b7f-016b-480f-abd5-92d5b9cca85f",
      "userId": "12345678"
    }
  }' | python3 -m json.tool

echo ""
echo "==================================="
echo "✅ Tests completed!"
echo ""
echo "💡 Tips:"
echo "  - The default searchId (088d4b7f-016b-480f-abd5-92d5b9cca85f) has 50 rental properties in Coral Gables under \$5k/mo"
echo "  - All follow-up queries will route to property_operations node automatically"
echo "  - Check logs: tail -f /tmp/agent.log"
echo "  - Agent listens on: http://localhost:3003"
echo ""
