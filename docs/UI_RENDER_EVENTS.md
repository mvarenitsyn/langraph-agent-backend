# UI Render Events Integration Guide

## Overview

The LangGraph agent now emits UI render events to a dedicated Pub/Sub topic (`ui.render`) to trigger frontend rendering of search results and other UI components. This enables real-time, synchronized UI updates based on agent tool execution.

---

## Agent Implementation (Completed)

### What Was Implemented

1. **UI Event Types** (`src/types/ui-events.ts`)
   - Defined generic `UIRenderEvent` structure
   - Created typed payloads for each render type

2. **UI Event Publisher** (`src/pubsub/ui-event-publisher.ts`)
   - Singleton publisher for `ui.render` topic
   - Convenience methods for different event types
   - Error handling (non-blocking)

3. **Auto-Emission in Tools Node** (`src/nodes/tools.ts`)
   - Automatically detects `property_search` results
   - Emits UI event with `searchId` immediately after tool execution
   - Runs in parallel with response generation

4. **Configuration** (`src/config/index.ts`)
   - Added Pub/Sub configuration section
   - Configurable topic name and project ID

---

## Event Structure

### Topic Name
```
ui.render
```

### Event Format

```typescript
{
  id: "550e8400-e29b-41d4-a716-446655440000",  // UUID v4
  type: "ui.render",                            // Fixed event type
  timestamp: "2025-01-16T10:30:00.000Z",        // ISO 8601
  source: "agent",                               // Always "agent"

  // Synchronization Keys
  sessionId: "thread-abc123",                    // Required: Your session/thread ID
  userId: "user-xyz789",                         // Optional: User identifier
  correlationId: "corr-456def",                  // Required: Links to original query

  // Payload
  payload: {
    renderType: "search_results",                // Event type identifier
    data: {
      searchId: "search-uuid-here",              // UUID of search results
      totalCount: 45,                            // Number of properties found
      searchToken: "shareable-token-abc",        // Optional: Shareable token
      mapLink: "https://..."                     // Optional: Direct map link
    }
  }
}
```

### Data Fields for `search_results`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `searchId` | string | **Yes** | UUID of search results to fetch/display |
| `totalCount` | number | **Yes** | Number of properties found |
| `searchToken` | string | No | Shareable token for search |
| `mapLink` | string | No | Direct link to map view |

---

## Synchronization Strategy

### Triple Key System

1. **`sessionId`** - Routes event to correct user's WebSocket connection
2. **`correlationId`** - Matches UI event with text response (for queue & wait)
3. **`searchId`** - Links to actual property data resource

### Event Flow

```
1. User sends query → Backend publishes to agent.task.request
   - Includes: sessionId, userId, correlationId

2. Agent executes property_search tool → Returns searchId

3. Tools node emits UI event → Pub/Sub: ui.render
   - Event contains: sessionId, correlationId, searchId
   - Happens IMMEDIATELY after tool execution

4. Agent continues → Generates conversational response

5. Agent publishes final response → Pub/Sub: agent.task.response
   - Contains same correlationId

6. Frontend receives both events:
   - UI event (with searchId) → Queue it
   - Text response (with correlationId) → Match & render
```

---

## Backend Integration (If Needed)

### Option 1: No Backend Changes (Recommended)

If your frontend can subscribe to Pub/Sub directly:
- Backend does nothing
- Frontend subscribes to `ui.render` topic
- Agent → Pub/Sub → Frontend (direct)

### Option 2: SocketIO Bridge

If frontend needs events via WebSocket, add this to your backend's SocketIO bridge:

**File**: `nov6/lib/event-bus/bridges/socketio-bridge.ts`

```typescript
// Subscribe to ui.render topic
const uiRenderSubscription = this.pubsub
  .subscription('ui-render-backend-sub');

uiRenderSubscription.on('message', async (message) => {
  try {
    const event = JSON.parse(message.data.toString());
    const { sessionId, payload, correlationId, timestamp } = event;

    // Forward to WebSocket client by sessionId
    this.io.to(sessionId).emit('ui.render', {
      renderType: payload.renderType,
      data: payload.data,
      correlationId,
      timestamp,
    });

    console.log(`[SocketIO] Forwarded UI event: ${payload.renderType} to session ${sessionId}`);
    message.ack();
  } catch (error) {
    console.error('[SocketIO] Failed to forward UI event:', error);
    message.nack();
  }
});
```

**Create Subscription in GCP**:
```bash
gcloud pubsub subscriptions create ui-render-backend-sub \
  --topic=ui.render \
  --project=gen-lang-client-0355624828 \
  --ack-deadline=60
```

---

## Frontend Integration

### Subscription Details

**If subscribing via Pub/Sub directly:**

```typescript
import { PubSub } from '@google-cloud/pubsub';

const pubsub = new PubSub({
  projectId: 'gen-lang-client-0355624828',
});

// Create subscription (do this once in GCP Console or via gcloud)
const subscription = pubsub.subscription('ui-render-frontend-sub');

subscription.on('message', (message) => {
  const event = JSON.parse(message.data.toString());

  // Filter by your sessionId
  if (event.sessionId === currentSessionId) {
    handleUIRenderEvent(event);
  }

  message.ack();
});

subscription.on('error', (error) => {
  console.error('[Pub/Sub] Subscription error:', error);
});
```

**If receiving via WebSocket (Backend bridge):**

```typescript
// Listen on Socket.IO
socket.on('ui.render', (event) => {
  handleUIRenderEvent(event);
});
```

### Queue & Wait Implementation

```typescript
// State management
const uiEventQueue = new Map<string, UIEvent>();
const textResponses = new Map<string, string>();

function handleUIRenderEvent(event) {
  const { renderType, data, correlationId } = event.payload
    ? event.payload
    : { renderType: event.renderType, data: event.data, correlationId: event.correlationId };

  if (renderType === 'search_results') {
    // Queue this event with correlationId
    uiEventQueue.set(correlationId, {
      type: 'search_results',
      searchId: data.searchId,
      totalCount: data.totalCount,
      searchToken: data.searchToken,
      mapLink: data.mapLink,
    });

    console.log(`[UI Events] Queued search_results event (corr: ${correlationId}, searchId: ${data.searchId})`);

    // Check if matching text response already arrived
    tryRenderQueuedEvents();
  }
}

// Also listen for text responses
socket.on('agent:response', (response) => {
  const { correlationId, text } = response;

  // Store text response
  textResponses.set(correlationId, text);

  console.log(`[Text Response] Received for correlationId: ${correlationId}`);

  // Try to render queued UI events
  tryRenderQueuedEvents();
});

function tryRenderQueuedEvents() {
  uiEventQueue.forEach((event, correlationId) => {
    const textResponse = textResponses.get(correlationId);

    if (textResponse) {
      console.log(`[Render] Both UI event and text available for ${correlationId}`);

      // Both UI event and text response available - render!
      if (event.type === 'search_results') {
        renderSearchResults(event.searchId, textResponse, event.totalCount);
      }

      // Remove from queue and responses
      uiEventQueue.delete(correlationId);
      textResponses.delete(correlationId);
    }
  });
}

function renderSearchResults(searchId: string, explanation: string, totalCount: number) {
  // 1. Display conversational explanation
  addMessageToChat({
    role: 'assistant',
    content: explanation,
  });

  // 2. Fetch and render property data
  fetchSearchResults(searchId).then((properties) => {
    // Update map with markers
    mapComponent.displayProperties(properties);

    // Update results list
    resultsListComponent.render(properties);

    // Show count badge
    showResultsCount(totalCount);
  });
}
```

### GCP Subscription Setup (Frontend)

```bash
gcloud pubsub subscriptions create ui-render-frontend-sub \
  --topic=ui.render \
  --project=gen-lang-client-0355624828 \
  --ack-deadline=60 \
  --message-retention-duration=10m
```

---

## Testing

### Manual Test Flow

1. **Start Agent**:
   ```bash
   cd /Users/mikhail/projects/myvista/langraph-agent
   npm run dev
   ```

2. **Send Property Search Request**:
   - Via Pub/Sub: Publish to `agent.task.request` with sessionId
   - Via HTTP: `POST /chat` with threadId

3. **Check Agent Logs**:
   ```
   [ToolsNode] Emitted UI event for searchId: abc-123-def
   [UIEventPublisher] Published search_results (msgId: 1234567890)
   ```

4. **Verify Pub/Sub**:
   - GCP Console → Pub/Sub → Topics → `ui.render`
   - Check for published messages
   - Or pull from subscription:
     ```bash
     gcloud pubsub subscriptions pull ui-render-backend-sub --limit=5
     ```

5. **Verify Event Structure**:
   - Check `sessionId`, `correlationId`, `searchId` are present
   - Verify `payload.renderType === 'search_results'`
   - Confirm `payload.data.searchId` matches tool output

---

## Configuration

### Environment Variables

Add to your `.env` file:

```bash
# Google Cloud Pub/Sub
GCP_PROJECT_ID=gen-lang-client-0355624828
UI_RENDER_TOPIC=ui.render

# For local development with emulator
# PUBSUB_EMULATOR_HOST=localhost:8085
```

### Configuration Object

Access via `config.pubsub`:

```typescript
import { config } from './config';

console.log(config.pubsub.projectId);     // "gen-lang-client-0355624828"
console.log(config.pubsub.uiRenderTopic); // "ui.render"
```

---

## Future Enhancements

### Additional Render Types

Currently supported:
- ✅ `search_results` - Display property search results

Planned:
- ⏳ `cma_report` - Show CMA PDF or interactive report
- ⏳ `property_details` - Open property detail modal
- ⏳ `update_map_bounds` - Pan/zoom map to specific area

### Adding New Render Types

1. **Define payload type** in `src/types/ui-events.ts`:
   ```typescript
   export interface CMAReportPayload {
     cmaId: string;
     pdfUrl?: string;
     propertyAddress: string;
   }
   ```

2. **Add convenience method** in `src/pubsub/ui-event-publisher.ts`:
   ```typescript
   async publishCMAReport(params: PublishCMAReportParams): Promise<void> {
     await this.publishUIEvent({
       renderType: 'cma_report',
       data: params,
       sessionId: params.sessionId,
       userId: params.userId,
       correlationId: params.correlationId,
     });
   }
   ```

3. **Add handler** in `src/nodes/tools.ts`:
   ```typescript
   if (toolName === 'generate_cma' && content.success && content.cmaId) {
     await uiEventPublisher.publishCMAReport({
       cmaId: content.cmaId,
       pdfUrl: content.pdfUrl,
       propertyAddress: content.propertyAddress,
       sessionId,
       userId,
       correlationId,
     });
   }
   ```

---

## Troubleshooting

### Events not appearing in Pub/Sub

1. Check agent logs for emission confirmation:
   ```
   [ToolsNode] Emitted UI event for searchId: ...
   [UIEventPublisher] Published search_results (msgId: ...)
   ```

2. Verify topic exists:
   ```bash
   gcloud pubsub topics list --project=gen-lang-client-0355624828
   ```

3. Check IAM permissions:
   - Agent needs `pubsub.publisher` role on `ui.render` topic

### Events arriving but not rendering

1. Verify `correlationId` matches between UI event and text response
2. Check browser console for queue/response logs
3. Ensure `sessionId` routing works in backend bridge
4. Verify frontend is listening to correct Socket.IO event or Pub/Sub subscription

### Timing issues

If UI events arrive much earlier than text responses:
- Normal! Tools execute fast (~5s), response generation takes longer (~10-15s)
- Queue implementation handles this gracefully
- Consider showing loading indicator while waiting for text

---

## Summary

**Agent Emits**:
- Topic: `ui.render`
- When: Immediately after `property_search` tool execution
- Contains: `sessionId`, `correlationId`, `searchId`, `totalCount`

**Backend Needs** (Optional):
- Subscribe to `ui.render` topic
- Forward to frontend via Socket.IO

**Frontend Needs**:
- Subscribe to `ui.render` (Pub/Sub or Socket.IO)
- Queue events by `correlationId`
- Wait for matching text response
- Render both together when available

**Synchronization**:
- `sessionId` → Routes to correct user
- `correlationId` → Matches UI event with text response
- `searchId` → Links to data resource
