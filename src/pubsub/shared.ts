/**
 * Shared Pub/Sub Publisher Instance
 * Used by nodes to emit progress events without creating multiple PubSub clients
 */

import { PubSub } from '@google-cloud/pubsub';
import { AgentPublisher } from './publisher.js';

// Create shared PubSub client and publisher
const pubsub = new PubSub();
export const sharedPublisher = new AgentPublisher(pubsub);
