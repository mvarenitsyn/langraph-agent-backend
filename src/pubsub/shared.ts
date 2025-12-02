/**
 * Shared Pub/Sub Publisher Instance
 * Used by nodes to emit progress events without creating multiple PubSub clients
 *
 * Cloud Run Resilience: Configured with shorter timeouts to prevent
 * DEADLINE_EXCEEDED errors from crashing the agent service.
 */

import { PubSub, PublishOptions } from '@google-cloud/pubsub';
import { AgentPublisher } from './publisher.js';

// Cloud Run-optimized publish settings
// Faster failure + fewer retries = better UX when Pub/Sub is unhealthy
const publishSettings: PublishOptions = {
  batching: {
    maxBytes: 1024 * 1024, // 1 MB
    maxMessages: 100,
    maxMilliseconds: 10, // Flush quickly for real-time streaming
  },
  gaxOpts: {
    timeout: 10000, // 10 second timeout (vs default 60s)
    retry: {
      // Fail fast on Cloud Run - don't block agent execution
      retryCodes: [14], // Only retry UNAVAILABLE, not DEADLINE_EXCEEDED
      backoffSettings: {
        initialRetryDelayMillis: 100,
        retryDelayMultiplier: 1.3,
        maxRetryDelayMillis: 1000,
        initialRpcTimeoutMillis: 5000,
        rpcTimeoutMultiplier: 1.0,
        maxRpcTimeoutMillis: 10000,
        totalTimeoutMillis: 15000, // Max 15s total (vs 60s default)
      },
    },
  },
};

// Create shared PubSub client with Cloud Run-optimized settings
// Shorter timeouts prevent stale connection issues on cold starts
let pubsubInstance: PubSub | null = null;
let lastCreated = 0;
const CLIENT_MAX_AGE_MS = 5 * 60 * 1000; // Recreate client every 5 minutes

function getPubSubClient(): PubSub {
  const now = Date.now();

  // Recreate client periodically to avoid stale gRPC connections
  if (!pubsubInstance || (now - lastCreated) > CLIENT_MAX_AGE_MS) {
    if (pubsubInstance) {
      console.log('[PubSub] Recreating client to prevent stale connections');
    }

    pubsubInstance = new PubSub({
      // Project ID auto-detected from GCP metadata
      ...(process.env.PUBSUB_EMULATOR_HOST && {
        apiEndpoint: process.env.PUBSUB_EMULATOR_HOST,
      }),
    });
    lastCreated = now;
  }

  return pubsubInstance;
}

// Export getter function for fresh client access
export function getSharedPubSub(): PubSub {
  return getPubSubClient();
}

// Export publish settings for use in publisher
export { publishSettings };

// Create publisher with fresh client getter
export const sharedPublisher = new AgentPublisher(getPubSubClient(), publishSettings);
