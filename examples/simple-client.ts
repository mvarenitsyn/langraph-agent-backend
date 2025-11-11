/**
 * Example: Simple Non-Streaming Client
 *
 * Demonstrates how to use the simple chat endpoint
 */

async function simpleChatExample() {
  console.log('🚀 Sending request...\n');

  const response = await fetch('http://localhost:3002/chat/simple', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: 'What are the current real estate market trends in Oakland?',
      threadId: 'user-demo-456',
    }),
  });

  const data = await response.json();

  if (data.success) {
    console.log('✅ Response received:\n');
    console.log('─'.repeat(60));
    console.log(data.response);
    console.log('─'.repeat(60));
    console.log(`\nThread ID: ${data.threadId}`);
  } else {
    console.error('❌ Error:', data.error);
  }
}

// Run the example
simpleChatExample().catch(console.error);
