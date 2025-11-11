# Frontend Integration Guide - LangGraph Agent

## What is This Agent?

The LangGraph Agent is an intelligent property search assistant that uses the **RRR Pattern** (Router-Reflect-Retry) to ensure high-quality responses. It combines:

- **Multiple AI Tools**: Property search, Perplexity web research, property details lookup
- **Quality Control**: Reflection system that evaluates responses and retries if needed
- **Persistent Memory**: Conversations saved to PostgreSQL, resumable across sessions
- **Real-time Streaming**: Server-Sent Events (SSE) for live progress updates

## Agent Workflow (RRR Pattern)

```
User Query
    ↓
1. ROUTER → Analyzes query, calls appropriate tools (property_search, perplexity_search, etc.)
    ↓
2. REFLECT → Evaluates tool results quality, decides PROCEED/RETRY/ERROR
    ↓
3. RETRY → If quality is low, retry with different parameters (max 3 retries)
    ↓
4. GENERATE → Synthesizes final response from all gathered information
```

## API Endpoints

### Base URL
```
http://localhost:3003
```

### 1. Non-Streaming Endpoint (Simple)

**Endpoint**: `POST /chat/simple`

**Use Case**: When you want a single response without progress updates.

**Request**:
```typescript
interface SimpleRequest {
  query: string;      // User's question
  threadId?: string;  // Optional: conversation ID for persistence
}
```

**Response**:
```typescript
interface SimpleResponse {
  success: boolean;
  response: string;   // Final answer
  threadId: string;   // Conversation ID
  metadata: {
    reflectionRecommendation: "PROCEED" | "RETRY" | "ERROR";
    shouldRetry: boolean;
  };
}
```

**Example**:
```javascript
const response = await fetch('http://localhost:3003/chat/simple', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: 'Find 3 bedroom homes in San Francisco under $1.5M',
    threadId: 'user-123'
  })
});

const data = await response.json();
console.log(data.response); // Final answer
```

---

### 2. Streaming Endpoint (Real-time)

**Endpoint**: `POST /chat`

**Use Case**: When you want to show live progress as the agent works (like ChatGPT's streaming).

**Request**: Same as `/chat/simple`

**Response**: Server-Sent Events (SSE) stream

**Event Types**:

```typescript
// 1. Step Start Event
interface StepStartEvent {
  nodeName: string;        // "router", "reflect", "retry", "generate_response"
  stepNumber: number;      // Current step (1, 2, 3...)
  state: {
    query: string;
    retryCount: number;
  };
}

// 2. Step End Event
interface StepEndEvent {
  nodeName: string;
  stepNumber: number;
  duration: number;        // Milliseconds
  state: {
    completed: boolean;
  };
}

// 3. Final Event
interface FinalEvent {
  response: string;        // Complete answer
  totalSteps: number;      // Total workflow steps
  totalDuration: number;   // Total execution time (ms)
}
```

---

## Frontend Integration Examples

### React Example - Non-Streaming

```typescript
import { useState } from 'react';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

function PropertySearchChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [threadId] = useState(() => `user-${Date.now()}`);

  const sendMessage = async () => {
    if (!input.trim()) return;

    // Add user message
    const userMessage: Message = { role: 'user', content: input };
    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setLoading(true);

    try {
      const response = await fetch('http://localhost:3003/chat/simple', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: input,
          threadId: threadId
        })
      });

      const data = await response.json();

      if (data.success) {
        const assistantMessage: Message = {
          role: 'assistant',
          content: data.response
        };
        setMessages(prev => [...prev, assistantMessage]);
      } else {
        throw new Error('Failed to get response');
      }
    } catch (error) {
      console.error('Error:', error);
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: 'Sorry, an error occurred. Please try again.'
      }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="chat-container">
      <div className="messages">
        {messages.map((msg, idx) => (
          <div key={idx} className={`message ${msg.role}`}>
            {msg.content}
          </div>
        ))}
        {loading && <div className="loading">Agent is thinking...</div>}
      </div>

      <div className="input-area">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
          placeholder="Ask about properties..."
        />
        <button onClick={sendMessage} disabled={loading}>
          Send
        </button>
      </div>
    </div>
  );
}
```

---

### React Example - Streaming with Progress

```typescript
import { useState, useRef } from 'react';

interface StreamingStep {
  nodeName: string;
  status: 'in_progress' | 'completed';
  duration?: number;
}

function StreamingPropertyChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [steps, setSteps] = useState<StreamingStep[]>([]);
  const [threadId] = useState(() => `user-${Date.now()}`);
  const abortControllerRef = useRef<AbortController | null>(null);

  const sendStreamingMessage = async () => {
    if (!input.trim()) return;

    const userMessage: Message = { role: 'user', content: input };
    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setLoading(true);
    setSteps([]);

    // Create abort controller for cancellation
    abortControllerRef.current = new AbortController();

    try {
      const response = await fetch('http://localhost:3003/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: input,
          threadId: threadId
        }),
        signal: abortControllerRef.current.signal
      });

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) throw new Error('No reader available');

      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = JSON.parse(line.slice(6));

            if (line.startsWith('event: step.start')) {
              setSteps(prev => [...prev, {
                nodeName: data.nodeName,
                status: 'in_progress'
              }]);
            } else if (line.startsWith('event: step.end')) {
              setSteps(prev => prev.map(step =>
                step.nodeName === data.nodeName
                  ? { ...step, status: 'completed', duration: data.duration }
                  : step
              ));
            } else if (line.startsWith('event: final')) {
              // Final response received
              const assistantMessage: Message = {
                role: 'assistant',
                content: data.response
              };
              setMessages(prev => [...prev, assistantMessage]);
            }
          }
        }
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.log('Request cancelled');
      } else {
        console.error('Error:', error);
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: 'Sorry, an error occurred. Please try again.'
        }]);
      }
    } finally {
      setLoading(false);
      setSteps([]);
      abortControllerRef.current = null;
    }
  };

  const cancelRequest = () => {
    abortControllerRef.current?.abort();
    setLoading(false);
    setSteps([]);
  };

  return (
    <div className="chat-container">
      <div className="messages">
        {messages.map((msg, idx) => (
          <div key={idx} className={`message ${msg.role}`}>
            {msg.content}
          </div>
        ))}

        {loading && (
          <div className="streaming-progress">
            <div className="progress-header">
              Agent is working...
              <button onClick={cancelRequest}>Cancel</button>
            </div>
            <div className="steps">
              {steps.map((step, idx) => (
                <div key={idx} className={`step ${step.status}`}>
                  <span className="step-name">{step.nodeName}</span>
                  {step.status === 'completed' && (
                    <span className="duration">({step.duration}ms)</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="input-area">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyPress={(e) => e.key === 'Enter' && sendStreamingMessage()}
          placeholder="Ask about properties..."
          disabled={loading}
        />
        <button onClick={sendStreamingMessage} disabled={loading}>
          Send
        </button>
      </div>
    </div>
  );
}
```

---

### Vanilla JavaScript - EventSource API

For simpler SSE handling, you can use the EventSource API (note: only works with GET requests, so you'd need to modify the endpoint):

```javascript
// Alternative: Using fetch with manual SSE parsing (works with POST)
async function streamChat(query, threadId, onStep, onFinal) {
  const response = await fetch('http://localhost:3003/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, threadId })
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;

      const eventLine = lines[lines.indexOf(line) - 1];
      const eventType = eventLine?.replace('event: ', '') || 'unknown';
      const data = JSON.parse(line.slice(6));

      if (eventType === 'step.start' || eventType === 'step.end') {
        onStep && onStep(eventType, data);
      } else if (eventType === 'final') {
        onFinal && onFinal(data);
      }
    }
  }
}

// Usage
streamChat(
  'Find homes in Miami',
  'user-123',
  (eventType, data) => {
    console.log(`Step: ${data.nodeName} - ${eventType}`);
  },
  (data) => {
    console.log('Final response:', data.response);
  }
);
```

---

## Conversation History

**Endpoint**: `GET /history/:threadId`

**Use Case**: Resume conversations or show chat history.

```typescript
async function loadHistory(threadId: string) {
  const response = await fetch(`http://localhost:3003/history/${threadId}`);
  const data = await response.json();

  if (data.success && data.state) {
    console.log('Query:', data.state.query);
    console.log('Final Response:', data.state.finalResponse);
    console.log('Tool Results:', data.state.toolResults);
    console.log('Reflection:', data.state.reflection);
  }
}
```

---

## Available Tools (What the Agent Can Do)

### 1. `property_search`
Search properties by location, price, bedrooms, type.

**Example queries**:
- "Find 3 bedroom homes in San Francisco under $1.5M"
- "Show me condos in Miami Beach"
- "Properties in Austin with at least 4 bedrooms"

### 2. `property_details`
Get detailed information about a specific property.

**Example queries**:
- "Tell me more about 123 Main St, San Francisco"
- "What are the details for property at 456 Oak Ave?"

### 3. `perplexity_search`
General web research using Perplexity AI.

**Example queries**:
- "What are the average home prices in Seattle?"
- "Tell me about the Miami real estate market"
- "Best neighborhoods for families in Austin"

### 4. `perplexity_real_estate_research`
Real estate-specific research with citations.

**Example queries**:
- "What are the real estate trends in 2025?"
- "Compare housing markets in Austin vs San Francisco"

---

## RRR Pattern Benefits

### Why This Matters for Frontend

1. **Reliability**: Agent retries on poor results instead of returning garbage
2. **Transparency**: See exactly what the agent is doing (router → reflect → retry)
3. **Quality**: Reflection system ensures responses are relevant and complete
4. **Context**: Persistent memory means conversations continue across sessions

### Step Names You'll See

- **router** - Analyzing query and calling tools
- **reflect** - Evaluating response quality
- **retry** - Attempting again with improved approach
- **generate_response** - Creating final answer

---

## Error Handling

```typescript
interface ErrorResponse {
  success: false;
  error: string;
  details?: string;
}

async function handleRequest(query: string) {
  try {
    const response = await fetch('http://localhost:3003/chat/simple', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    });

    const data = await response.json();

    if (!data.success) {
      // Handle agent-level errors
      console.error('Agent error:', data.error);
      return;
    }

    return data.response;
  } catch (error) {
    // Handle network errors
    console.error('Network error:', error);
  }
}
```

---

## Performance Considerations

- **Non-streaming**: Response time ~5-15 seconds depending on query complexity
- **Streaming**: First event arrives within 1-2 seconds, provides immediate feedback
- **Retries**: If quality is low, agent may retry up to 3 times (adds 5-10s per retry)
- **Caching**: Conversation state cached in PostgreSQL for instant history retrieval

---

## CORS Configuration

If calling from a web app on a different domain, ensure CORS is enabled on the backend:

```typescript
// Already configured in the agent
app.use(cors({
  origin: '*', // Or specify your frontend domain
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));
```

---

## Testing

```bash
# Simple test
curl -X POST http://localhost:3003/chat/simple \
  -H "Content-Type: application/json" \
  -d '{"query":"Find homes in San Francisco","threadId":"test-123"}'

# Streaming test
curl -N -X POST http://localhost:3003/chat \
  -H "Content-Type: application/json" \
  -d '{"query":"What are home prices in Boston?","threadId":"test-456"}'

# History test
curl http://localhost:3003/history/test-123
```

---

## Summary

**Choose Non-Streaming** (`/chat/simple`) when:
- You want a simple request/response
- You don't need to show progress
- You're building a traditional form submission

**Choose Streaming** (`/chat`) when:
- You want to show live progress (like ChatGPT)
- User experience is important during long operations
- You want to display which tools are being called

**Key Advantage**: The RRR pattern ensures you get high-quality, relevant responses instead of hallucinated or incomplete answers.
