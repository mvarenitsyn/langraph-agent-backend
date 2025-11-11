/**
 * Example: Multi-Turn Conversation
 *
 * Demonstrates how persistent memory works across multiple messages
 */

async function conversationExample() {
  const threadId = 'user-demo-conversation-789';

  // First message
  console.log('👤 User: "Find 3 bedroom homes in San Francisco"\n');

  let response = await fetch('http://localhost:3002/chat/simple', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: 'Find 3 bedroom homes in San Francisco',
      threadId,
    }),
  });

  let data = await response.json();
  console.log('🤖 Assistant:', data.response.substring(0, 200) + '...\n');

  // Wait a bit
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Follow-up message (references previous context)
  console.log('👤 User: "What about ones under $1.2M?"\n');

  response = await fetch('http://localhost:3002/chat/simple', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: 'What about ones under $1.2M?',
      threadId, // Same thread ID = conversation continues
    }),
  });

  data = await response.json();
  console.log('🤖 Assistant:', data.response.substring(0, 200) + '...\n');

  // Get conversation history
  console.log('📜 Retrieving conversation history...\n');

  response = await fetch(`http://localhost:3002/history/${threadId}`);
  const history = await response.json();

  console.log('Conversation state:');
  console.log(`- Query: ${history.state.query}`);
  console.log(`- Messages: ${history.state.messages.length}`);
  console.log(`- Retry count: ${history.state.retryCount}`);
}

// Run the example
conversationExample().catch(console.error);
