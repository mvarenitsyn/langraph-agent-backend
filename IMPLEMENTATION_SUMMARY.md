# UI Render Events Implementation Summary

## ✅ What Was Implemented

### 1. Core Infrastructure

**Files Created:**
- `src/types/ui-events.ts` - TypeScript interfaces for UI events
- `src/pubsub/ui-event-publisher.ts` - Singleton publisher for ui.render topic
- `src/pubsub/index.ts` - Centralized Pub/Sub exports

**Files Modified:**
- `src/nodes/tools.ts` - Auto-emit UI events after property_search tool
- `src/config/index.ts` - Added Pub/Sub configuration (projectId, uiRenderTopic)
- `.env.example` - Added GCP_PROJECT_ID and UI_RENDER_TOPIC
- `src/utils/openai.ts` - Fixed config references (pre-existing bug)

**Documentation Created:**
- `docs/UI_RENDER_EVENTS.md` - Complete reference documentation
- `docs/BACKEND_INTEGRATION.md` - Backend SocketIO bridge setup guide
- `docs/UI_RENDER_INTEGRATION.md` - Quick start guide for frontend

### 2. How It Works

```
User Query
    ↓
Agent executes property_search tool
    ↓
Tools node detects searchId in result
    ↓ (Immediately - non-blocking)
Publishes to Pub/Sub topic: ui.render
    {
      renderType: "search_results",
      data: { searchId, totalCount, ... },
      correlationId: "corr-123"
    }
    ↓ (Continues in parallel)
Agent generates conversational response
    ↓
Publishes to agent.task.response
    {
      text: "I found 45 properties...",
      correlationId: "corr-123"
    }
```

### 3. Synchronization Strategy

**Triple Key System:**
1. `sessionId` - Routes to correct WebSocket connection
2. `correlationId` - Matches UI event with text response
3. `searchId` - Links to actual property data

**Queue & Wait Pattern:**
- Frontend queues UI events by correlationId
- Frontend queues text responses by correlationId
- When both with same correlationId arrive → Render together

---

## 📋 Backend Integration (Optional)

### Option 1: No Backend Changes

If frontend can subscribe to Pub/Sub directly, no backend changes needed.

### Option 2: SocketIO Bridge

If frontend expects events via WebSocket:

1. Create GCP subscription:
   ```bash
   gcloud pubsub subscriptions create ui-render-backend-sub \
     --topic=ui.render \
     --project=gen-lang-client-0355624828
   ```

2. Add to SocketIO bridge (`nov6/lib/event-bus/bridges/socketio-bridge.ts`):
   ```typescript
   const subscription = this.pubsub.subscription('ui-render-backend-sub');

   subscription.on('message', (message) => {
     const event = JSON.parse(message.data.toString());

     this.io.to(event.sessionId).emit('ui.render', {
       renderType: event.payload.renderType,
       data: event.payload.data,
       correlationId: event.correlationId,
     });

     message.ack();
   });
   ```

**Full guide**: See `docs/BACKEND_INTEGRATION.md`

---

## 🎨 Frontend Integration

### Minimal Code (Socket.IO)

```typescript
const uiEventQueue = new Map();
const textResponses = new Map();

socket.on('ui.render', (event) => {
  uiEventQueue.set(event.correlationId, event.data);
  tryRender();
});

socket.on('agent:response', (response) => {
  textResponses.set(response.correlationId, response.text);
  tryRender();
});

function tryRender() {
  uiEventQueue.forEach((data, correlationId) => {
    const text = textResponses.get(correlationId);
    if (text) {
      displaySearchResults(data.searchId, text);
      uiEventQueue.delete(correlationId);
      textResponses.delete(correlationId);
    }
  });
}
```

**Full guide**: See `docs/UI_RENDER_INTEGRATION.md`

---

## 🔍 Event Structure

### Topic
```
ui.render
```

### Message (Pub/Sub)
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "type": "ui.render",
  "timestamp": "2025-01-16T10:30:00.000Z",
  "source": "agent",
  "sessionId": "thread-abc123",
  "userId": "user-xyz789",
  "correlationId": "corr-456def",
  "payload": {
    "renderType": "search_results",
    "data": {
      "searchId": "search-uuid-here",
      "totalCount": 45,
      "searchToken": "shareable-token-abc",
      "mapLink": "https://..."
    }
  }
}
```

### Event (Socket.IO)
```json
{
  "renderType": "search_results",
  "data": {
    "searchId": "abc-123",
    "totalCount": 45,
    "searchToken": "token-abc",
    "mapLink": "https://..."
  },
  "correlationId": "corr-456",
  "timestamp": "2025-01-16T10:30:00.000Z"
}
```

---

## ✅ Testing

### 1. Build & Start Agent

```bash
cd /Users/mikhail/projects/myvista/langraph-agent
npm run build  # Should succeed with no errors
npm run dev    # Start agent on port 3003
```

### 2. Trigger Property Search

Via Pub/Sub or HTTP:
```bash
curl -X POST http://localhost:3003/chat/simple \
  -H "Content-Type: application/json" \
  -d '{"query":"Find homes in Miami","threadId":"test-123"}'
```

### 3. Check Agent Logs

```
[ToolsNode] Emitted UI event for searchId: abc-123-def-456
[UIEventPublisher] Published search_results (msgId: 1234567890, session: test-123)
```

### 4. Verify Pub/Sub Topic

```bash
# Check topic exists
gcloud pubsub topics describe ui.render \
  --project=gen-lang-client-0355624828

# Pull test message (if subscription exists)
gcloud pubsub subscriptions pull ui-render-backend-sub \
  --limit=1 \
  --project=gen-lang-client-0355624828
```

---

## 🚀 Future Enhancements

### Additional Render Types (Planned)

Currently supported:
- ✅ `search_results` - Display property search results

Future:
- ⏳ `cma_report` - Show CMA PDF or interactive report
- ⏳ `property_details` - Open property detail modal
- ⏳ `update_map_bounds` - Pan/zoom map to area

### Adding New Render Types

See `docs/UI_RENDER_EVENTS.md` section "Future Enhancements" for implementation guide.

---

## 📊 Performance Impact

- **UI Event Emission**: ~10-50ms (non-blocking)
- **UI Event Arrival**: ~5 seconds after query (tool execution time)
- **Text Response Arrival**: ~10-15 seconds after query
- **Total UX Improvement**: Events arrive 5-10s before text, enabling preload

---

## 🔑 Key Files Reference

| File | Purpose |
|------|---------|
| `src/types/ui-events.ts` | Event type definitions |
| `src/pubsub/ui-event-publisher.ts` | Pub/Sub publisher |
| `src/nodes/tools.ts` | Auto-emission logic |
| `src/config/index.ts` | Configuration |
| `docs/UI_RENDER_EVENTS.md` | Complete reference |
| `docs/BACKEND_INTEGRATION.md` | Backend bridge setup |
| `docs/UI_RENDER_INTEGRATION.md` | Frontend quick start |

---

## 📝 Configuration

### Environment Variables

```bash
# Google Cloud Pub/Sub
GCP_PROJECT_ID=gen-lang-client-0355624828
UI_RENDER_TOPIC=ui.render

# For local development with emulator
# PUBSUB_EMULATOR_HOST=localhost:8085
```

### GCP Resources

**Topic**: `ui.render`
- Created automatically on first publish
- Or manually: `gcloud pubsub topics create ui.render --project=gen-lang-client-0355624828`

**Subscriptions** (if needed):
- Backend: `ui-render-backend-sub`
- Frontend: `ui-render-frontend-sub`

---

## 🎯 Summary

**What was built**: A unified event emitter that automatically publishes UI render events when tools return renderable data.

**What backend needs**: Optionally add SocketIO bridge to forward events to frontend (20 lines of code).

**What frontend needs**: Subscribe to events, queue by correlationId, render when text arrives.

**Key innovation**: Synchronization via `correlationId` enables queue & wait pattern for coordinated UI updates.

**Next steps**:
1. Backend: Decide on Option 1 (direct Pub/Sub) or Option 2 (SocketIO bridge)
2. Frontend: Implement queue & wait pattern using docs
3. Test: Verify events arrive and match by correlationId
4. Iterate: Add more render types as needed (CMA reports, property details, etc.)
