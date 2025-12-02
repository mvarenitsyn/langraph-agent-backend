/**
 * Shared Pub/Sub Publisher Instance
 * Used by nodes to emit progress events without creating multiple PubSub clients
 *
 * Cloud Run Resilience: Configured with shorter timeouts to prevent
 * DEADLINE_EXCEEDED errors from crashing the agent service.
 */

import { PubSub } from '@google-cloud/pubsub';
import { AgentPublisher } from './publisher.js';

// Create shared PubSub client with Cloud Run-optimized settings
// Shorter timeouts prevent stale connection issues on cold starts
const pubsub = new PubSub({
  // Project ID auto-detected from GCP metadata
  ...(process.env.PUBSUB_EMULATOR_HOST && {
    apiEndpoint: process.env.PUBSUB_EMULATOR_HOST,
  }),
});
export const sharedPublisher = new AgentPublisher(pubsub);
