import { AgentStateType } from "../types/state.js";

/**
 * Retry Node - Third step in RRR pattern
 *
 * Handles retry logic based on reflection analysis.
 * Decides whether to retry the router node or proceed to response generation.
 */

export async function retryNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.log('\n[Retry] Evaluating retry decision...');

  const recommendation = state.metadata?.reflectionRecommendation;
  const currentRetryCount = state.retryCount || 0;
  const maxRetries = state.maxRetries || 3;

  console.log(`[Retry] Current retry count: ${currentRetryCount}/${maxRetries}`);
  console.log(`[Retry] Recommendation: ${recommendation}`);

  // Check if we should retry
  if (recommendation === 'RETRY' && currentRetryCount < maxRetries) {
    console.log('[Retry] → Retrying router node...');
    return {
      retryCount: currentRetryCount + 1,
      metadata: {
        ...state.metadata,
        shouldRetry: true,
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
 * Returns 'router' to retry or 'generate_response' to proceed
 */
export function shouldRetryRoute(state: AgentStateType): string {
  const shouldRetry = state.metadata?.shouldRetry;

  if (shouldRetry) {
    return 'router';
  }

  return 'generate_response';
}
