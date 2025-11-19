/**
 * Test script for retry logic with specific address
 * Usage: node test-retry-logic.js
 */

import https from 'https';

// Accept self-signed certificates for local testing
const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});

async function testRetryLogic() {
  const testQuery = "1000 W Island Blvd Apt 2309, Aventura, FL 33160";
  const threadId = `test-retry-${Date.now()}`;

  console.log('\n🧪 Testing Retry Logic with Address Query');
  console.log('===========================================');
  console.log(`Query: ${testQuery}`);
  console.log(`Thread ID: ${threadId}`);
  console.log('');

  try {
    const response = await fetch('http://localhost:3003/chat/simple', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: testQuery,
        threadId: threadId,
      }),
      agent: httpsAgent,
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    console.log('📊 Response received:');
    console.log('-------------------');
    console.log(JSON.stringify(data, null, 2));
    console.log('');

    // Check if reflection was triggered
    if (data.reflection) {
      console.log('✅ Reflection was triggered!');
      console.log(`Reflection content: ${data.reflection.substring(0, 200)}...`);
    } else {
      console.log('⚠️  No reflection found in response');
    }

    // Check retry count
    if (data.retryCount !== undefined) {
      console.log(`🔄 Retry count: ${data.retryCount}`);
    }

    // Check metadata for recovery strategy
    if (data.metadata?.recoveryStrategy) {
      console.log('🎯 Recovery Strategy Found:');
      console.log(`  - Issue: ${data.metadata.issueAnalysis}`);
      console.log(`  - Strategy: ${data.metadata.recoveryStrategy}`);
    }

    // Check if fast-path was used
    if (data.metadata?.skipRRR) {
      console.log('⚡ Fast-path optimization was used (RRR skipped)');
    }

  } catch (error) {
    console.error('❌ Error testing retry logic:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
  }
}

// Run the test
testRetryLogic()
  .then(() => {
    console.log('\n✅ Test completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  });
