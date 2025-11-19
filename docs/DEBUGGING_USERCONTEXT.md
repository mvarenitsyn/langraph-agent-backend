# Debugging UserContext Flow

## Purpose

This document explains the debug logging added to trace why userContext is not being received by the agent properly.

---

## Debug Logging Added

### 1. Pub/Sub Subscriber (`src/pubsub/subscriber.ts`)

**Lines 52-84**: Full Pub/Sub message inspection

```typescript
console.log('[Subscriber] ====== DEBUG: Full Pub/Sub Message ======');
console.log('[Subscriber] Raw message data:', JSON.stringify(data, null, 2));

console.log('[Subscriber] ====== DEBUG: Extracted Fields ======');
console.log('[Subscriber] sessionId:', sessionId);
console.log('[Subscriber] userId:', userId);
console.log('[Subscriber] metadata:', JSON.stringify(metadata, null, 2));
console.log('[Subscriber] payload:', JSON.stringify(payload, null, 2));

console.log('[Subscriber] ====== DEBUG: UserContext Extraction ======');
console.log('[Subscriber] payload.userContext exists?', !!payload?.userContext);
console.log('[Subscriber] Extracted userContext:', JSON.stringify(userContext, null, 2));
```

**Lines 139-141**: Graph invocation state

```typescript
console.log('[Subscriber] ====== DEBUG: Graph Invocation ======');
console.log('[Subscriber] Initial state being passed to graph:', JSON.stringify(initialState, null, 2));
console.log('[Subscriber] Config being passed to graph:', JSON.stringify(config, null, 2));
```

### 2. Router Node (`src/nodes/router.ts`)

**Lines 23-37**: State received by router

```typescript
console.log('[Router] ====== DEBUG: State Received ======');
console.log('[Router] state.metadata exists?', !!state.metadata);
console.log('[Router] state.metadata:', JSON.stringify(state.metadata, null, 2));
console.log('[Router] state.userContext exists?', !!state.userContext);
console.log('[Router] state.userContext:', JSON.stringify(state.userContext, null, 2));

console.log('[Router] ====== DEBUG: UserContext Extraction ======');
console.log('[Router] Using userContext from:', state.metadata?.userContext ? 'metadata' : (state.userContext ? 'state' : 'default'));
console.log('[Router] Final userContext:', JSON.stringify(userContext, null, 2));
```

### 3. Generate Response Node (`src/nodes/generate-response.ts`)

**Lines 15-30**: State received by generate-response

```typescript
console.log('[GenerateResponse] ====== DEBUG: State Received ======');
console.log('[GenerateResponse] state.metadata exists?', !!state.metadata);
console.log('[GenerateResponse] state.metadata:', JSON.stringify(state.metadata, null, 2));
console.log('[GenerateResponse] state.userContext exists?', !!state.userContext);
console.log('[GenerateResponse] state.userContext:', JSON.stringify(state.userContext, null, 2));

console.log('[GenerateResponse] ====== DEBUG: UserContext Extraction ======');
console.log('[GenerateResponse] Using userContext from:', state.metadata?.userContext ? 'metadata' : (state.userContext ? 'state' : 'default'));
console.log('[GenerateResponse] Final userContext:', JSON.stringify(userContext, null, 2));
```

---

## What to Check

### Step 1: Verify Pub/Sub Message Structure

**Expected Log** (from subscriber):
```json
[Subscriber] ====== DEBUG: Full Pub/Sub Message ======
[Subscriber] Raw message data: {
  "id": "uuid-v4",
  "type": "agent.task.request",
  "payload": {
    "query": "Find homes in Miami",
    "userContext": {
      "isAuthenticated": true,
      "fullName": "Mike",
      "email": "mike@example.com"
    }
  },
  "sessionId": "thread-123",
  "userId": "user-456",
  "metadata": {
    "correlationId": "corr-123"
  }
}
```

**Questions to Answer**:
- ✅ Does `payload.userContext` exist in the Pub/Sub message?
- ✅ Does it contain `isAuthenticated`, `fullName`, `email`?
- ✅ Is the data correct (Mike's name, authenticated=true)?

**If NO**: The frontend/backend is NOT sending userContext correctly → Fix in backend

**If YES**: Continue to Step 2

---

### Step 2: Verify Graph Receives UserContext

**Expected Log** (from subscriber):
```json
[Subscriber] ====== DEBUG: Graph Invocation ======
[Subscriber] Initial state being passed to graph: {
  "message": "Find homes in Miami",
  "toolResults": {},
  "retryCount": 0,
  "maxRetries": 3,
  "metadata": {
    "sessionId": "thread-123",
    "userId": "user-456",
    "correlationId": "corr-123",
    "userContext": {
      "isAuthenticated": true,
      "fullName": "Mike",
      "email": "mike@example.com"
    }
  }
}
```

**Questions to Answer**:
- ✅ Is `metadata.userContext` in the initial state?
- ✅ Does it contain the correct user data?

**If NO**: Extraction logic in subscriber is broken → Check lines 69-71 in subscriber.ts

**If YES**: Continue to Step 3

---

### Step 3: Verify Router Node Receives Metadata

**Expected Log** (from router on FIRST invocation):
```
[Router] ====== DEBUG: State Received ======
[Router] state.metadata exists? true
[Router] state.metadata: {
  "sessionId": "thread-123",
  "userId": "user-456",
  "correlationId": "corr-123",
  "userContext": {
    "isAuthenticated": true,
    "fullName": "Mike",
    "email": "mike@example.com"
  }
}
[Router] state.userContext exists? true
[Router] state.userContext: { "isAuthenticated": false }  // ← Default value

[Router] ====== DEBUG: UserContext Extraction ======
[Router] Using userContext from: metadata
[Router] Final userContext: {
  "isAuthenticated": true,
  "fullName": "Mike",
  "email": "mike@example.com"
}
[Router] User: Mike (authenticated=true)
```

**Questions to Answer**:
- ✅ Does `state.metadata.userContext` exist on first invocation?
- ✅ Is the fallback to `state.userContext` working correctly?
- ✅ Does the router correctly extract Mike's name?

**If NO**: LangGraph is not passing metadata to nodes → Check LangGraph configuration

**If YES on first turn but NO on subsequent turns**: Continue to Step 4

---

### Step 4: Check Persistence Across Turns (CRITICAL)

**Test Scenario**:
1. User says: "My name is Mike"
2. Agent responds: "Hi Mike!"
3. User says: "What's my name?"
4. Agent should respond: "Your name is Mike"

**Expected Logs on SECOND message** (after conversation history):

**Router Node**:
```
[Router] ====== DEBUG: State Received ======
[Router] state.metadata exists? ???  ← KEY QUESTION: Does metadata persist?
[Router] state.metadata: ??? ← Is userContext still here?
[Router] state.userContext: ??? ← Did state.userContext get updated?

[Router] Using userContext from: ??? ← Which source is being used?
```

**Possible Outcomes**:

**Outcome A** (Bug: Metadata not persisting):
```
[Router] state.metadata exists? false  // ❌ Lost after first turn
[Router] state.userContext: { "isAuthenticated": false }  // ❌ Still default
[Router] Using userContext from: default  // ❌ Fallback to guest
[Router] User: there (authenticated=false)  // ❌ BUG
```

**Outcome B** (Bug: State not updated):
```
[Router] state.metadata exists? false  // Metadata cleared (expected)
[Router] state.userContext: { "isAuthenticated": false }  // ❌ Never updated
[Router] Using userContext from: state  // ✅ Using state
[Router] User: there (authenticated=false)  // ❌ BUG
```

**Outcome C** (Working):
```
[Router] state.metadata exists? true/false  // Doesn't matter
[Router] state.userContext: {
  "isAuthenticated": true,
  "fullName": "Mike"
}  // ✅ Updated from first turn
[Router] Using userContext from: state  // ✅ Using state
[Router] User: Mike (authenticated=true)  // ✅ WORKING
```

---

## Root Cause Analysis

### If Outcome A (Metadata not persisting):

**Problem**: LangGraph does NOT persist `metadata` across node invocations—it's only available during the initial invocation.

**Why**: The `metadata` field is for configuration/runtime context, not for state management. LangGraph's state schema only persists fields defined in `AgentState`.

**Solution**: Need to copy `userContext` from `metadata` into `state.userContext` during the first node execution, OR pass it at the top level of initial state.

### If Outcome B (State not updated):

**Problem**: No node is updating `state.userContext` from `metadata.userContext` during the first invocation.

**Why**: All nodes READ from `state.metadata.userContext || state.userContext`, but none WRITE to `state.userContext`.

**Solution**: The router node (or subscriber) needs to return `{ userContext }` to update the state after extracting from metadata.

### If Outcome C (Working):

**Unexpected**: This would mean the implementation is already correct, and the issue is elsewhere (possibly frontend not sending userContext, or backend not forwarding it).

---

## Testing Instructions

1. **Deploy with debug logging**:
   ```bash
   npm run build
   npm run dev  # or deploy to production
   ```

2. **Test conversation flow**:
   - Send message: "My name is Mike"
   - Send message: "What's my name?"

3. **Collect logs**:
   - Copy ALL debug logs from both messages
   - Look for the patterns described in Step 4

4. **Identify the outcome**:
   - Match logs to Outcome A, B, or C above
   - Follow the corresponding solution

---

## Expected Fix (Based on Outcome)

**If Outcome A or B**: Need to ensure `state.userContext` is populated from `metadata.userContext`

**Option 1**: Update subscriber to pass userContext at top level
```typescript
const streamEvents = graph.streamEvents({
  message: query,
  userContext,  // ✅ Top level
  metadata: { sessionId, userId, correlationId, userContext }
});
```

**Option 2**: Update router to return userContext in state
```typescript
return {
  messages: [userMessage, response],
  userContext,  // ✅ Update state
  metadata: { ...state.metadata }
};
```

---

## Cleanup

Once the issue is identified and fixed, these debug logs can be removed or reduced to minimal logging (just the summary lines).
