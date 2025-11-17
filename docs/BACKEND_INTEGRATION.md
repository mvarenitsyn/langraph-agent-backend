# Backend Integration - UI Render Events

## Quick Start

The agent now publishes UI render events to the `ui.render` Pub/Sub topic. You have two options for integrating this with your backend.

---

## Option 1: No Backend Changes (Recommended)

**Use this if your frontend can subscribe to Pub/Sub directly.**

### Pros
- Simplest implementation
- No backend code changes needed
- Direct agent → frontend communication

### Cons
- Frontend needs Pub/Sub client library
- Frontend needs GCP credentials

### Implementation
1. Create frontend subscription in GCP:
   ```bash
   gcloud pubsub subscriptions create ui-render-frontend-sub \
     --topic=ui.render \
     --project=gen-lang-client-0355624828
   ```

2. Frontend subscribes directly (see `FRONTEND_INTEGRATION.md`)

3. Done!

---

## Option 2: SocketIO Bridge (If Frontend Needs WebSocket)

**Use this if your frontend expects events via Socket.IO.**

### Implementation Steps

#### 1. Create Backend Subscription

```bash
gcloud pubsub subscriptions create ui-render-backend-sub \
  --topic=ui.render \
  --project=gen-lang-client-0355624828 \
  --ack-deadline=60
```

#### 2. Add Subscription Handler to SocketIO Bridge

**File**: `nov6/lib/event-bus/bridges/socketio-bridge.ts`

**Location**: In your SocketIO bridge initialization (likely in constructor or `start()` method)

```typescript
/**
 * Subscribe to UI render events and forward to WebSocket clients
 */
private subscribeToUIRenderEvents(): void {
  const subscription = this.pubsub.subscription('ui-render-backend-sub');

  subscription.on('message', async (message) => {
    try {
      const event = JSON.parse(message.data.toString());
      const { sessionId, payload, correlationId, timestamp, userId } = event;

      // Log for debugging
      console.log(`[SocketIO Bridge] UI render event: ${payload.renderType} for session ${sessionId}`);

      // Forward to WebSocket client by sessionId
      // The sessionId is used as the Socket.IO room
      this.io.to(sessionId).emit('ui.render', {
        renderType: payload.renderType,
        data: payload.data,
        correlationId,
        timestamp,
        userId,
      });

      // Acknowledge message
      message.ack();
    } catch (error) {
      console.error('[SocketIO Bridge] Failed to forward UI render event:', error);
      message.nack();
    }
  });

  subscription.on('error', (error) => {
    console.error('[SocketIO Bridge] UI render subscription error:', error);
  });

  console.log('[SocketIO Bridge] Subscribed to ui-render-backend-sub');
}
```

#### 3. Call Subscription Method

In your bridge initialization:

```typescript
async start(): Promise<void> {
  // ... existing code ...

  // Subscribe to agent events (existing)
  this.subscribeToAgentEvents();

  // Subscribe to UI render events (NEW)
  this.subscribeToUIRenderEvents();

  console.log('[SocketIO Bridge] All subscriptions active');
}
```

#### 4. Verify Implementation

Test with logs:

```bash
# Start backend
cd /Users/mikhail/projects/myvista/nov6
npm start

# Watch for logs:
# [SocketIO Bridge] Subscribed to ui-render-backend-sub
# [SocketIO Bridge] UI render event: search_results for session thread-123
```

---

## Event Structure Forwarded to Frontend

**Socket.IO Event Name**: `ui.render`

**Payload Structure**:
```typescript
{
  renderType: "search_results",              // Event type
  data: {
    searchId: "search-uuid-here",            // UUID
    totalCount: 45,                          // Number
    searchToken: "shareable-token-abc",      // Optional string
    mapLink: "https://..."                   // Optional string
  },
  correlationId: "corr-456def",              // UUID
  timestamp: "2025-01-16T10:30:00.000Z",     // ISO 8601
  userId: "user-xyz789"                      // Optional string
}
```

---

## Testing

### 1. Verify Subscription Exists

```bash
gcloud pubsub subscriptions describe ui-render-backend-sub \
  --project=gen-lang-client-0355624828
```

Expected output:
```yaml
name: projects/gen-lang-client-0355624828/subscriptions/ui-render-backend-sub
topic: projects/gen-lang-client-0355624828/topics/ui.render
ackDeadlineSeconds: 60
```

### 2. Pull Test Message

Trigger a property search from frontend, then:

```bash
gcloud pubsub subscriptions pull ui-render-backend-sub \
  --limit=1 \
  --project=gen-lang-client-0355624828
```

Expected output:
```
┌─────────────────────────────────────────────┬──────────────────┬────────────┐
│                    DATA                     │   MESSAGE_ID     │ ATTRIBUTES │
├─────────────────────────────────────────────┼──────────────────┼────────────┤
│ {"id":"...","type":"ui.render",...}         │ 1234567890       │            │
└─────────────────────────────────────────────┴──────────────────┴────────────┘
```

### 3. Check Backend Logs

```bash
# Watch logs
tail -f /tmp/backend.log

# Expected output:
# [SocketIO Bridge] Subscribed to ui-render-backend-sub
# [SocketIO Bridge] UI render event: search_results for session thread-abc123
```

### 4. Verify Frontend Receives Event

In browser console:

```javascript
socket.on('ui.render', (event) => {
  console.log('Received UI render event:', event);
});

// Expected output:
// Received UI render event: {
//   renderType: "search_results",
//   data: { searchId: "...", totalCount: 45, ... },
//   correlationId: "...",
//   timestamp: "..."
// }
```

---

## IAM Permissions

### Backend Service Account Needs:

```bash
# Grant Pub/Sub Subscriber role
gcloud pubsub subscriptions add-iam-policy-binding ui-render-backend-sub \
  --member="serviceAccount:YOUR_BACKEND_SERVICE_ACCOUNT@gen-lang-client-0355624828.iam.gserviceaccount.com" \
  --role="roles/pubsub.subscriber" \
  --project=gen-lang-client-0355624828
```

---

## Error Handling

### Subscription Errors

```typescript
subscription.on('error', (error) => {
  console.error('[SocketIO Bridge] UI render subscription error:', error);

  // Optional: Implement retry logic
  if (error.code === 'UNAVAILABLE') {
    setTimeout(() => {
      console.log('[SocketIO Bridge] Reconnecting to ui-render subscription...');
      this.subscribeToUIRenderEvents();
    }, 5000);
  }
});
```

### Message Processing Errors

```typescript
subscription.on('message', async (message) => {
  try {
    const event = JSON.parse(message.data.toString());

    // Validate required fields
    if (!event.sessionId || !event.payload) {
      console.error('[SocketIO Bridge] Invalid UI render event:', event);
      message.ack(); // Ack to prevent redelivery of malformed message
      return;
    }

    // Forward to client
    this.io.to(event.sessionId).emit('ui.render', {
      renderType: event.payload.renderType,
      data: event.payload.data,
      correlationId: event.correlationId,
      timestamp: event.timestamp,
    });

    message.ack();
  } catch (error) {
    console.error('[SocketIO Bridge] Failed to process UI render event:', error);
    message.nack(); // Nack for redelivery
  }
});
```

---

## Monitoring

### Check Subscription Metrics

```bash
# View undelivered messages
gcloud pubsub subscriptions describe ui-render-backend-sub \
  --project=gen-lang-client-0355624828 \
  --format="value(numUndeliveredMessages)"

# View oldest unacked message age
gcloud pubsub subscriptions describe ui-render-backend-sub \
  --project=gen-lang-client-0355624828 \
  --format="value(oldestUnackedMessageAge)"
```

### Cloud Monitoring Metrics

- **Undelivered messages**: `pubsub.googleapis.com/subscription/num_undelivered_messages`
- **Ack latency**: `pubsub.googleapis.com/subscription/ack_latency`
- **Pull request count**: `pubsub.googleapis.com/subscription/pull_request_count`

---

## Summary

**Minimal Backend Changes**:
1. Create subscription: `ui-render-backend-sub`
2. Add subscription handler in SocketIO bridge (~20 lines of code)
3. Forward events to frontend via `socket.emit('ui.render', ...)`

**No Backend Changes**:
- Frontend subscribes directly to Pub/Sub
- Skip this entire document!

**Choose based on**:
- Frontend capability (can it use Pub/Sub directly?)
- Infrastructure preference (WebSocket vs Pub/Sub)
- Security requirements (GCP credentials in frontend?)
