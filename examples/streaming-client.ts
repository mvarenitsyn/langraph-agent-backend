/**
 * Example: Streaming Client
 *
 * Demonstrates how to consume the streaming chat endpoint
 */

async function streamingChatExample() {
  const response = await fetch('http://localhost:3002/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: 'Find 3 bedroom homes in San Francisco under $1.5M',
      threadId: 'user-demo-123',
    }),
  });

  if (!response.body) {
    throw new Error('No response body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  console.log('🎬 Streaming started...\n');

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        console.log('\n✅ Stream complete');
        break;
      }

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n\n');

      for (const line of lines) {
        if (line.startsWith('event:')) {
          const eventMatch = line.match(/event: (.+)/);
          const dataMatch = line.match(/data: (.+)/s);

          if (eventMatch && dataMatch) {
            const eventType = eventMatch[1];
            const eventData = JSON.parse(dataMatch[1]);

            // Handle different event types
            switch (eventType) {
              case 'step.start':
                console.log(`\n📍 Step ${eventData.stepNumber}: ${eventData.nodeName} started`);
                break;

              case 'step.end':
                console.log(`✓ Step ${eventData.stepNumber}: ${eventData.nodeName} completed (${eventData.duration}ms)`);
                break;

              case 'tool.start':
                console.log(`🔧 Tool "${eventData.toolName}" invoked`);
                break;

              case 'tool.end':
                console.log(`✓ Tool "${eventData.toolName}" completed (${eventData.duration}ms)`);
                break;

              case 'final':
                console.log(`\n🎯 Final Response (${eventData.totalSteps} steps, ${eventData.totalDuration}ms):`);
                console.log('─'.repeat(60));
                console.log(eventData.response);
                console.log('─'.repeat(60));
                break;

              case 'error':
                console.error(`❌ Error in ${eventData.nodeName}: ${eventData.error}`);
                break;
            }
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// Run the example
streamingChatExample().catch(console.error);
