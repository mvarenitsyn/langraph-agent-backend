/**
 * User Response Subscriber for Human-in-the-Loop
 *
 * Subscribes to user.response topic and resumes interrupted graph workflows.
 * This enables full Pub/Sub architecture - no direct HTTP calls needed.
 */

import { PubSub, Message } from '@google-cloud/pubsub';
import { Command } from '@langchain/langgraph';
import { createAgentGraph } from '../graph/index.js';

interface UserResponseMessage {
  resume: string;          // User's selected option value
  threadId: string;        // LangGraph thread ID (same as sessionId)
  sessionId: string;       // Frontend session ID
  promptType?: string;     // CLARIFY_PROPERTY_TYPE, MISSING_REQUIRED_FIELD, etc.
  timestamp?: string;      // When user responded
}

export class UserResponseSubscriber {
  private subscription: any;

  constructor(private pubsub: PubSub) {}

  /**
   * Start listening to user.response topic
   */
  async start(): Promise<void> {
    const subscriptionName = 'user-response-agent-sub';

    // Use shorter timeout when emulator is configured (fast fail for local dev)
    const isEmulator = !!process.env.PUBSUB_EMULATOR_HOST;
    const timeout = isEmulator ? 5000 : 30000; // 5s for emulator, 30s for production

    try {
      this.subscription = this.pubsub.subscription(subscriptionName);

      // Check if subscription exists with timeout
      const [exists] = await Promise.race([
        this.subscription.exists(),
        new Promise<[boolean]>((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout connecting to Pub/Sub (${timeout}ms)`)), timeout)
        )
      ]) as [boolean];
      if (!exists) {
        console.log(`[UserResponseSubscriber] Creating subscription: ${subscriptionName}`);
        const topic = this.pubsub.topic('user.response');
        const [topicExists] = await topic.exists();
        if (!topicExists) {
          console.log('[UserResponseSubscriber] Creating topic: user.response');
          await topic.create();
        }
        await topic.createSubscription(subscriptionName);
        this.subscription = this.pubsub.subscription(subscriptionName);
      }

      console.log(`[UserResponseSubscriber] Listening to: ${subscriptionName}`);

      // Handle messages
      this.subscription.on('message', async (message: Message) => {
        await this.handleMessage(message);
      });

      this.subscription.on('error', (error: Error) => {
        console.error('[UserResponseSubscriber] Subscription error:', error);
      });

      console.log('[UserResponseSubscriber] ✓ User response subscriber started');
    } catch (error) {
      console.error('[UserResponseSubscriber] Failed to start:', error);
      console.warn('[UserResponseSubscriber] ⚠️  HITL subscriber disabled - resume via HTTP POST /chat/simple still available');
      // Don't throw - allow server to start without Pub/Sub subscriber
      // The HTTP endpoint for resume still works
    }
  }

  /**
   * Handle incoming user response
   */
  private async handleMessage(message: Message): Promise<void> {
    try {
      const data: UserResponseMessage = JSON.parse(message.data.toString());

      console.log('[UserResponseSubscriber] ====== Received User Response ======');
      console.log('[UserResponseSubscriber] threadId:', data.threadId);
      console.log('[UserResponseSubscriber] sessionId:', data.sessionId);
      console.log('[UserResponseSubscriber] promptType:', data.promptType);
      console.log('[UserResponseSubscriber] resume value:', data.resume);
      console.log('[UserResponseSubscriber] =====================================');

      if (!data.resume || !data.threadId) {
        console.warn('[UserResponseSubscriber] Missing resume or threadId, acking anyway');
        message.ack();
        return;
      }

      // Resume the interrupted graph
      const graph = await createAgentGraph();
      const configurable = { configurable: { thread_id: data.threadId } };

      console.log(`[UserResponseSubscriber] 🔄 Resuming thread ${data.threadId} with value: "${data.resume}"`);

      try {
        // Use Command({ resume }) to continue from where the graph paused
        const result = await graph.invoke(
          new Command({ resume: data.resume }),
          configurable
        );

        // Check if graph interrupted again (nested interrupt)
        if (result && (result as any).__interrupt__) {
          const interrupts = (result as any).__interrupt__;
          const interruptInfo = interrupts[0];
          console.log(`[UserResponseSubscriber] ⏸️  Graph interrupted again: ${interruptInfo.value?.type || 'unknown'}`);
          // The ui-event-publisher will handle publishing the new interrupt to Pub/Sub
        } else {
          console.log('[UserResponseSubscriber] ✓ Graph completed successfully');
          console.log('[UserResponseSubscriber] Final response:',
            result.finalResponse?.substring(0, 100) + '...' || 'N/A'
          );
        }

        message.ack();
      } catch (graphError: any) {
        console.error('[UserResponseSubscriber] Graph execution error:', graphError);

        // Check if it's a "no tasks to resume" error (graph already completed)
        if (graphError.message?.includes('no tasks to resume')) {
          console.warn('[UserResponseSubscriber] No interrupted task found - graph may have completed or timed out');
          message.ack(); // Ack to avoid redelivery
        } else {
          // For other errors, nack to retry
          message.nack();
        }
      }
    } catch (error) {
      console.error('[UserResponseSubscriber] Message handling error:', error);
      message.nack(); // Nack to retry
    }
  }

  /**
   * Stop subscriber
   */
  async stop(): Promise<void> {
    if (this.subscription) {
      await this.subscription.close();
      console.log('[UserResponseSubscriber] Stopped');
    }
  }
}
