# UI Render Events Integration - Quick Start

## What Are UI Render Events?

UI render events are real-time notifications from the agent that tell the frontend to display specific UI components (like search results on a map) BEFORE the conversational response is ready.

### The Problem They Solve

Without UI events:
```
User: "Find homes in Miami"
  ↓ (10 seconds)
Agent: "I found 45 properties..." ← Text arrives
Frontend: Parses text, extracts searchId, fetches data, renders map
  ↓ (2 more seconds)
User sees map (12 seconds total)
```

With UI events:
```
User: "Find homes in Miami"
  ↓ (5 seconds)
Agent: UI event with searchId ← Arrives immediately after tool execution
Frontend: Queues event
  ↓ (5 more seconds)
Agent: "I found 45 properties..." ← Text arrives
Frontend: Renders map + text together (10 seconds total)
```

---

## How It Works

### 1. Agent emits UI event

After `property_search` tool executes:
```typescript
// Agent automatically publishes to Pub/Sub topic: ui.render
{
  renderType: "search_results",
  data: {
    searchId: "abc-123",
    totalCount: 45
  },
  correlationId: "corr-456",  // Same as text response
  sessionId: "thread-789"
}
```

### 2. Frontend queues event

```typescript
// Queue by correlationId
uiEventQueue.set(correlationId, {
  searchId: "abc-123",
  totalCount: 45
});
```

### 3. Agent sends text response

```typescript
{
  text: "I found 45 properties in Miami...",
  correlationId: "corr-456"  // Same as UI event
}
```

### 4. Frontend renders both

```typescript
// Match by correlationId
const uiEvent = uiEventQueue.get(correlationId);
const textResponse = textResponses.get(correlationId);

if (uiEvent && textResponse) {
  displayMap(uiEvent.searchId);
  showMessage(textResponse.text);
}
```

---

## Integration Options

### Option A: Socket.IO (Recommended - Simplest)

**Pros**: Works with existing backend, no GCP setup in frontend
**Cons**: Requires backend bridge

```typescript
socket.on('ui.render', (event) => {
  // Queue event by correlationId
  handleUIRenderEvent(event);
});

socket.on('agent:response', (response) => {
  // Match and render
  handleTextResponse(response);
});
```

### Option B: Direct Pub/Sub

**Pros**: More direct, no backend changes
**Cons**: Requires GCP credentials in frontend

```typescript
const subscription = pubsub.subscription('ui-render-frontend-sub');
subscription.on('message', (message) => {
  const event = JSON.parse(message.data.toString());
  handleUIRenderEvent(event);
});
```

---

## Minimal Implementation (Socket.IO)

### 1. State Management

```typescript
const uiEventQueue = new Map<string, UIEvent>();
const textResponses = new Map<string, string>();
```

### 2. Listen for Events

```typescript
socket.on('ui.render', (event) => {
  const { renderType, data, correlationId } = event;

  if (renderType === 'search_results') {
    uiEventQueue.set(correlationId, data);
    tryRender();
  }
});

socket.on('agent:response', (response) => {
  const { correlationId, text } = response;
  textResponses.set(correlationId, text);
  tryRender();
});
```

### 3. Render When Both Available

```typescript
function tryRender() {
  uiEventQueue.forEach((event, correlationId) => {
    const text = textResponses.get(correlationId);

    if (text) {
      // Both arrived - render!
      displaySearchResults(event.searchId, text);

      // Cleanup
      uiEventQueue.delete(correlationId);
      textResponses.delete(correlationId);
    }
  });
}
```

### 4. Display Results

```typescript
async function displaySearchResults(searchId: string, explanation: string) {
  // 1. Show agent's text
  addChatMessage(explanation);

  // 2. Fetch and display properties
  const properties = await fetchSearchResults(searchId);
  mapComponent.displayProperties(properties);
  resultsListComponent.render(properties);
}
```

---

## Event Structure

```typescript
{
  // Always "search_results" for now
  renderType: "search_results",

  // Data specific to render type
  data: {
    searchId: string,      // UUID of search results
    totalCount: number,    // Number of properties found
    searchToken?: string,  // Optional shareable token
    mapLink?: string       // Optional direct map link
  },

  // Synchronization key (CRITICAL)
  correlationId: string,   // Same as text response

  // Routing (for backend bridge)
  sessionId?: string,      // Your session ID
  userId?: string          // User identifier
}
```

---

## React Hook Example

```typescript
import { useEffect, useRef } from 'react';
import { io } from 'socket.io-client';

export function useUIRenderEvents(
  sessionId: string,
  onSearchResults: (searchId: string, text: string) => void
) {
  const queueRef = useRef(new Map());
  const responsesRef = useRef(new Map());

  useEffect(() => {
    const socket = io('https://localhost:3001');

    socket.on('ui.render', (event) => {
      queueRef.current.set(event.correlationId, event.data);
      tryRender();
    });

    socket.on('agent:response', (response) => {
      responsesRef.current.set(response.correlationId, response.text);
      tryRender();
    });

    function tryRender() {
      queueRef.current.forEach((data, correlationId) => {
        const text = responsesRef.current.get(correlationId);
        if (text) {
          onSearchResults(data.searchId, text);
          queueRef.current.delete(correlationId);
          responsesRef.current.delete(correlationId);
        }
      });
    }

    return () => socket.disconnect();
  }, [sessionId, onSearchResults]);
}
```

---

## Backend Setup (Socket.IO Bridge)

Only needed if frontend uses Socket.IO (Option A).

### 1. Create GCP Subscription

```bash
gcloud pubsub subscriptions create ui-render-backend-sub \
  --topic=ui.render \
  --project=gen-lang-client-0355624828
```

### 2. Add to SocketIO Bridge

```typescript
// In nov6/lib/event-bus/bridges/socketio-bridge.ts

const subscription = this.pubsub.subscription('ui-render-backend-sub');

subscription.on('message', (message) => {
  const event = JSON.parse(message.data.toString());

  // Forward to client
  this.io.to(event.sessionId).emit('ui.render', {
    renderType: event.payload.renderType,
    data: event.payload.data,
    correlationId: event.correlationId,
  });

  message.ack();
});
```

---

## Testing

### 1. Check Agent Logs

```
[ToolsNode] Emitted UI event for searchId: abc-123
[UIEventPublisher] Published search_results (msgId: 12345)
```

### 2. Check Browser Console

```typescript
socket.on('ui.render', (event) => {
  console.log('UI Event:', event);
});

// Expected:
// UI Event: {
//   renderType: "search_results",
//   data: { searchId: "abc-123", totalCount: 45 },
//   correlationId: "corr-456"
// }
```

### 3. Verify Matching

```typescript
console.log('Queued:', Array.from(uiEventQueue.keys()));
console.log('Responses:', Array.from(textResponses.keys()));

// Should see same correlationId in both
```

---

## Troubleshooting

### Events not arriving

1. Check agent is running: `npm run dev` in langraph-agent folder
2. Check backend bridge subscribed: Look for `[SocketIO Bridge] Subscribed to ui-render-backend-sub` in logs
3. Check GCP subscription exists:
   ```bash
   gcloud pubsub subscriptions describe ui-render-backend-sub
   ```

### Events arriving but not rendering

1. Verify `correlationId` matches:
   ```typescript
   console.log('UI event corr:', event.correlationId);
   console.log('Text corr:', response.correlationId);
   ```
2. Check queue logic:
   ```typescript
   console.log('Queue size:', uiEventQueue.size);
   console.log('Responses size:', textResponses.size);
   ```

### Timing issues

- UI events arrive ~5 seconds after query
- Text responses arrive ~10-15 seconds after query
- Queue & wait pattern handles this automatically

---

## Summary

**What you need**:
- Subscribe to `ui.render` events (Socket.IO or Pub/Sub)
- Queue events by `correlationId`
- Wait for matching text response
- Render both together

**Key insight**: `correlationId` is the synchronization key that links UI events with text responses.

**Full docs**: See `UI_RENDER_EVENTS.md` for complete reference.
