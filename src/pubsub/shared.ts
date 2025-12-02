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
// Balance between fast streaming and Cloud Run cold start resilience
const publishSettings: PublishOptions = {
  batching: {
    maxBytes: 1024 * 1024, // 1 MB
    maxMessages: 100,
    maxMilliseconds: 100, // Increased from 10ms to reduce publish frequency/backpressure
  },
  gaxOpts: {
    timeout: 30000, // 30 second timeout (increased from 10s for cold starts)
    retry: {
      // Retry both UNAVAILABLE and DEADLINE_EXCEEDED
      retryCodes: [14, 4], // UNAVAILABLE + DEADLINE_EXCEEDED
      backoffSettings: {
        initialRetryDelayMillis: 100,
        retryDelayMultiplier: 2, // Faster exponential backoff
        maxRetryDelayMillis: 5000,
        initialRpcTimeoutMillis: 10000,
        rpcTimeoutMultiplier: 1.5,
        maxRpcTimeoutMillis: 30000,
        totalTimeoutMillis: 60000, // 60s total (increased from 15s)
      },
    },
  },
  // Flow control to prevent backpressure when publishing faster than network can handle
  flowControlOptions: {
    maxOutstandingMessages: 100,
    maxOutstandingBytes: 10 * 1024 * 1024, // 10MB
  },
};

// Create shared PubSub client with Cloud Run-optimized settings
// Shorter timeouts prevent stale connection issues on cold starts
let pubsubInstance: PubSub | null = null;
let lastCreated = 0;
const CLIENT_MAX_AGE_MS = 5 * 60 * 1000; // Recreate client every 5 minutes

// Error tracking for adaptive client recreation
let consecutiveErrors = 0;
const MAX_ERRORS_BEFORE_RECREATION = 3;

/**
 * Report a Pub/Sub publish error - triggers client recreation after consecutive failures
 */
export function reportPubSubError(): void {
  consecutiveErrors++;
  if (consecutiveErrors >= MAX_ERRORS_BEFORE_RECREATION) {
    console.log(`[PubSub] ${consecutiveErrors} consecutive errors, forcing client recreation`);
    pubsubInstance = null;
    lastCreated = 0;
    consecutiveErrors = 0;
  }
}

/**
 * Report a successful Pub/Sub publish - resets error counter
 */
export function reportPubSubSuccess(): void {
  if (consecutiveErrors > 0) {
    console.log(`[PubSub] Success after ${consecutiveErrors} errors, resetting counter`);
  }
  consecutiveErrors = 0;
}

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
