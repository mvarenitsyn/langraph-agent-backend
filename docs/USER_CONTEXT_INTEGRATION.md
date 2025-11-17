# User Context Integration - LangGraph Agent

## Overview

The LangGraph agent now receives and uses user context information from the frontend/backend to provide personalized responses. This integration enables authenticated users to receive tailored responses that address them by name and maintain a personal tone.

---

## User Context Structure

### Data Received from Frontend

Every `agent.task.request` Pub/Sub message now includes a `userContext` object in the `payload`:

```typescript
{
  id: "uuid-v4",
  type: "agent.task.request",
  payload: {
    query: "Find homes in Miami",
    userContext: {
      isAuthenticated: boolean,           // Whether user is logged in
      fullName?: string,                  // User's full name (if authenticated)
      email?: string,                     // User's email (if authenticated)
      preferences?: Record<string, any>,  // Reserved for future use
      searchHistory?: string[],           // Reserved for future use
      savedProperties?: string[]          // Reserved for future use
    }
  },
  sessionId: "thread-123",
  userId: "user-456"
}
```

### Currently Populated Fields

✅ **Implemented**:
- `isAuthenticated` - Boolean flag for authentication status
- `fullName` - User's full name (e.g., "Sarah Johnson")
- `email` - User's email address

⏳ **Reserved for Future**:
- `preferences` - User preferences (locations, price ranges, etc.)
- `searchHistory` - Previous search queries
- `savedProperties` - Saved property IDs

---

## Implementation Details

### 1. Extraction in Pub/Sub Subscriber

**File**: `src/pubsub/subscriber.ts`

**Lines 61-64**: Extract userContext from payload
```typescript
// Extract user context from payload
const userContext = payload?.userContext || {
  isAuthenticated: false,
};
```

**Lines 69-74**: Log user context for debugging
```typescript
// Log user context for debugging
console.log('[Subscriber] User context:', {
  isAuthenticated: userContext.isAuthenticated,
  fullName: userContext.fullName || 'Guest',
  email: userContext.email ? '***@***' : 'None',
});
```

**Lines 122-127**: Pass to graph state
```typescript
metadata: {
  sessionId,
  userId,
  correlationId,
  userContext,  // Passed to graph
}
```

---

### 2. State Schema Definition

**File**: `src/types/state.ts`

**Lines 8-15**: UserContext interface
```typescript
export interface UserContext {
  isAuthenticated?: boolean;
  fullName?: string;
  email?: string;
  preferences?: Record<string, any>;
  searchHistory?: string[];
  savedProperties?: string[];
}
```

**Lines 101-104**: UserContext field in AgentState
```typescript
userContext: Annotation<UserContext>({
  reducer: (existing, incoming) => ({ ...existing, ...incoming }),
  default: () => ({ isAuthenticated: false }),
}),
```

---

### 3. Router Node Personalization

**File**: `src/nodes/router.ts`

**Lines 23-28**: Extract userContext
```typescript
// Extract user context for personalization
const userContext = state.metadata?.userContext || state.userContext || { isAuthenticated: false };
const userName = userContext.fullName || 'there';
const isAuthenticated = userContext.isAuthenticated || false;

console.log(`[Router] User: ${userName} (authenticated=${isAuthenticated})`);
```

**Lines 41-43**: Personalized system prompt
```typescript
const systemPrompt = isAuthenticated
  ? `You are RealVista, an intelligent AI assistant and real estate expert helping ${userName} find properties in South Florida.`
  : `You are RealVista, an intelligent AI assistant and real estate expert in South Florida. The user is browsing as a guest.`;
```

---

### 4. Generate Response Node Personalization

**File**: `src/nodes/generate-response.ts`

**Lines 15-21**: Extract userContext
```typescript
// Extract user context for personalization
const userContext = state.metadata?.userContext || state.userContext || { isAuthenticated: false };
const userName = userContext.fullName || 'there';
const firstName = userName.split(' ')[0]; // Use first name only
const isAuthenticated = userContext.isAuthenticated || false;

console.log(`[GenerateResponse] Personalizing for: ${firstName} (auth=${isAuthenticated})`);
```

**Lines 27-41**: Conditional response style
```typescript
const personalizedIntro = isAuthenticated
  ? `You are RealVista, a helpful real estate assistant helping ${userName} find properties in South Florida.`
  : `You are RealVista, a helpful real estate assistant specializing in South Florida. The user is browsing as a guest.`;

**RESPONSE STYLE: CONCISE & DIRECT**
${isAuthenticated
  ? `- Address the user by their first name: ${firstName}
- Maintain a personal, conversational tone
- Reference that you're helping them specifically`
  : `- Use a friendly, professional tone
- Avoid assuming the user has an account
- Consider suggesting account creation for personalized features`}
```

---

### 5. Tools Node Integration

**File**: `src/nodes/tools.ts`

**Line 32**: Extract userContext from state
```typescript
const userContext = state.metadata?.userContext || state.userContext;
```

**Lines 39-44**: Pass to tools
```typescript
const enhancedConfig = {
  ...config,
  metadata: {
    ...config?.metadata,
    sessionId,
    userId,
    userContext,  // Available to all tools
  },
};
```

---

### 6. Property Search Tool (Example)

**File**: `src/tools/property-search.ts`

**Lines 127-133**: Extract and log userContext
```typescript
const userContext = (config as any)?.metadata?.userContext || { isAuthenticated: false };

const userName = userContext.fullName || 'Guest';
const isAuthenticated = userContext.isAuthenticated || false;

console.log(`[PropertySearchTool] User: ${userName} (authenticated=${isAuthenticated})`);
```

---

## Testing

### Test 1: Authenticated User

**Input** (from frontend):
```json
{
  "payload": {
    "query": "Show me homes in Miami",
    "userContext": {
      "isAuthenticated": true,
      "fullName": "Sarah Johnson",
      "email": "sarah.j@example.com"
    }
  }
}
```

**Expected Logs**:
```
[Subscriber] User context: { isAuthenticated: true, fullName: 'Sarah Johnson', email: '***@***' }
[Router] User: Sarah Johnson (authenticated=true)
[GenerateResponse] Personalizing for: Sarah (auth=true)
[PropertySearchTool] User: Sarah Johnson (authenticated=true)
```

**Expected Response**:
```
Hi Sarah! I found 12 homes in Miami for you. Here are some great options...
```

---

### Test 2: Guest User

**Input** (from frontend):
```json
{
  "payload": {
    "query": "Show me condos in Austin",
    "userContext": {
      "isAuthenticated": false
    }
  }
}
```

**Expected Logs**:
```
[Subscriber] User context: { isAuthenticated: false, fullName: 'Guest', email: 'None' }
[Router] User: there (authenticated=false)
[GenerateResponse] Personalizing for: there (auth=false)
[PropertySearchTool] User: Guest (authenticated=false)
```

**Expected Response**:
```
I found 8 condos in Austin for you. Here are the top options...
```

---

## Benefits

### For Authenticated Users

✅ **Personal Greeting**: "Hi Sarah!" instead of generic greeting
✅ **Personalized Tone**: "I found these for you..." → "I found these for **you**, Sarah..."
✅ **Context Awareness**: Agent knows who it's helping
✅ **Future Features**: Can reference search history, preferences, saved properties

### For Guest Users

✅ **Professional Tone**: Maintains quality without personalization
✅ **Account Prompts**: Can suggest creating an account for features
✅ **No Assumption Errors**: Doesn't pretend to know user's name

---

## Data Flow

```
Frontend (User logged in as "Sarah Johnson")
    ↓
Extract from authStore: { isAuthenticated: true, fullName: "Sarah Johnson" }
    ↓
PropertySearchService sends userContext in request
    ↓
Backend Socket.IO Gateway receives userContext
    ↓
Backend AgentTaskPublisher includes in Pub/Sub payload
    ↓
Google Cloud Pub/Sub: agent.task.request
    ↓
LangGraph Agent Subscriber extracts from payload.userContext
    ↓
Passes to graph state.metadata.userContext
    ↓
Router Node: Personalizes system prompt
    ↓
Tools Node: Passes to tools via config.metadata.userContext
    ↓
Generate Response Node: Personalizes response with first name
    ↓
Response published with "Hi Sarah! I found 12 properties..."
```

---

## Future Enhancements

### Phase 1 (Current) ✅
- Extract userContext from Pub/Sub
- Personalize system prompts
- Address authenticated users by name
- Log user context for debugging

### Phase 2 (Planned) ⏳
- **User Preferences**: Store preferred locations, price ranges, property types
- **Search History**: Reference past searches in responses
  - "Similar to your recent search in Miami..."
- **Saved Properties**: Mention if user has saved similar properties
  - "This is similar to the property you saved last week..."

### Phase 3 (Advanced) 🔮
- **Smart Suggestions**: "Based on your searches, you might like..."
- **Price Alerts**: "Prices in your favorite area dropped by 5%"
- **Personalized Recommendations**: "Properties matching your profile"

---

## Security & Privacy

### What We Store
✅ **In Graph State (Temporary)**: userContext during execution
✅ **In Logs**: Redacted email (`***@***`), full name for debugging

### What We DON'T Store
❌ **Passwords**: Never sent or stored
❌ **JWT Tokens**: Only used for Socket.IO authentication
❌ **Payment Info**: Not included in userContext
❌ **Full Email in Logs**: Always redacted for privacy

### Best Practices
- Log redaction: Email shown as `***@***` in console logs
- No sensitive data in prompts sent to LLM
- UserContext only persists for single request execution
- Production logs should use minimal user identification

---

## Troubleshooting

### UserContext is undefined

**Check**: Pub/Sub message structure
```bash
gcloud pubsub subscriptions pull agent-task-request-agent-sub \
  --limit=1 \
  --project=gen-lang-client-0355624828
```

**Verify**: `payload.userContext` exists in message

**Solution**: Ensure frontend is sending userContext in request

---

### Personalization not working

**Check Logs**:
```
[Subscriber] User context: { ... }   ← Should show user data
[Router] User: Sarah (authenticated=true)   ← Should show user name
[GenerateResponse] Personalizing for: Sarah   ← Should use first name
```

**If all false**: Check userContext extraction in subscriber
**If router shows "there"**: userContext not reaching state
**If response generic**: Check generate-response node prompt

---

### Guest users seeing wrong tone

**Check**: `isAuthenticated` should be `false`
**Fix**: Ensure frontend sends `{ isAuthenticated: false }` for guests

---

## Summary

**Status**: ✅ COMPLETE
**Authenticated**: User addressed by first name in responses
**Guest**: Generic professional tone maintained
**Logs**: User context visible in all nodes for debugging
**Future Ready**: Infrastructure supports preferences, history, saved properties

**Next Steps**: Frontend team can now test personalization with logged-in and guest users.