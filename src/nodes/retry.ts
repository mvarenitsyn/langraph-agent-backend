import { AgentStateType } from "../types/state.js";
import { AgentPublisher } from "../pubsub/publisher.js";
import { PubSub } from "@google-cloud/pubsub";

/**
 * Retry Node - Third step in RRR pattern
 *
 * Handles retry logic based on reflection analysis.
 * Decides whether to retry the agent node or proceed to response generation.
 */

// Initialize Pub/Sub client
const pubsub = new PubSub();
const publisher = new AgentPublisher(pubsub);

/**
 * Generate user-friendly retry message based on retry count
 */
function getRetryMessage(retryCount: number, recoveryStrategy?: string): string {
  const messages = [
    "Let me try a different approach...",
    "I'm refining my search with additional criteria...",
    "Attempting an alternative method...",
  ];

  // Use retry count to select message (0-indexed)
  const message = messages[Math.min(retryCount, messages.length - 1)];

  // If we have specific recovery strategy, append it
  if (recoveryStrategy && retryCount === 0) {
    return `${message} ${recoveryStrategy}`;
  }

  return message;
}

export async function retryNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.log('\n[Retry] Evaluating retry decision...');

  const recommendation = state.metadata?.reflectionRecommendation;
  const currentRetryCount = state.retryCount || 0;
  const maxRetries = state.maxRetries || 3;

  console.log(`[Retry] Current retry count: ${currentRetryCount}/${maxRetries}`);
  console.log(`[Retry] Recommendation: ${recommendation}`);

  // Check if we should retry
  if (recommendation === 'RETRY' && currentRetryCount < maxRetries) {
    console.log('[Retry] → Retrying agent node...');

    // Publish short retry status message to user
    try {
      const sessionId = state.metadata?.sessionId || "unknown";
      const userId = state.metadata?.userId;
      const correlationId = state.metadata?.correlationId || `retry-${Date.now()}`;
      const recoveryStrategy = state.metadata?.recoveryStrategy;

      const retryMessage = getRetryMessage(currentRetryCount, recoveryStrategy);

      console.log(`[Retry] Publishing retry status: "${retryMessage}"`);

      // Publish short status message (not a full response)
      await publisher.publishTextChunk({
        correlationId,
        sessionId,
        userId,
        chunk: retryMessage,
        nodeId: `retry_${currentRetryCount + 1}`,
        isComplete: true,
      });

      console.log(`[Retry] ✓ Published retry status message`);
    } catch (error) {
      console.error(`[Retry] Failed to publish status message (non-fatal):`, error);
    }

    return {
      retryCount: currentRetryCount + 1,
      metadata: {
        ...state.metadata,
        shouldRetry: true,
        usedTools: false, // CRITICAL: Clear usedTools flag so router calls new tools instead of synthesizing old results
      },
    };
  }

  // Check if there's an error
  if (recommendation === 'ERROR') {
    console.log('[Retry] → Error detected, proceeding with best effort response');
    return {
      metadata: {
        ...state.metadata,
        shouldRetry: false,
        hasError: true,
      },
    };
  }

  // Max retries reached or recommendation is PROCEED
  if (currentRetryCount >= maxRetries) {
    console.log('[Retry] → Max retries reached, proceeding to response generation');
  } else {
    console.log('[Retry] → Quality sufficient, proceeding to response generation');
  }

  return {
    metadata: {
      ...state.metadata,
      shouldRetry: false,
    },
  };
}

/**
 * Conditional edge function for retry routing
 * Returns 'agent' to retry or 'generate_response' to proceed
 */
export function shouldRetryRoute(state: AgentStateType): string {
  const shouldRetry = state.metadata?.shouldRetry;

  if (shouldRetry) {
    return 'agent';
  }

  return 'generate_response';
}
