/**
 * Pub/Sub Subscriber for LangGraph Agent
 * Listens to agent.task.request and processes with graph
 */

import { PubSub, Message } from '@google-cloud/pubsub';
import { randomUUID } from 'crypto';
import { AgentPublisher } from './publisher.js';
import { createAgentGraph } from '../graph/index.js';

export class AgentSubscriber {
  private publisher: AgentPublisher;
  private subscription: any;

  constructor(private pubsub: PubSub) {
    this.publisher = new AgentPublisher(pubsub);
  }

  /**
   * Start listening to agent.task.request topic
   */
  async start(): Promise<void> {
    const subscriptionName = 'agent-task-request-agent-sub';

    try {
      this.subscription = this.pubsub.subscription(subscriptionName);

      console.log(`[Subscriber] Listening to: ${subscriptionName}`);

      // Handle messages
      this.subscription.on('message', async (message: Message) => {
        await this.handleMessage(message);
      });

      this.subscription.on('error', (error: Error) => {
        console.error('[Subscriber] Subscription error:', error);
      });

      console.log('[Subscriber] ✓ Agent subscriber started');
    } catch (error) {
      console.error('[Subscriber] Failed to start:', error);
      throw error;
    }
  }

  /**
   * Handle incoming task request
   */
  private async handleMessage(message: Message): Promise<void> {
    try {
      const data = JSON.parse(message.data.toString());
      console.log('[Subscriber] Received task:', data);

      const {
        payload,
        sessionId,
        userId,
        metadata,
      } = data;

      // Extract user context from payload
      const userContext = payload?.userContext || {
        isAuthenticated: false,
      };

      const correlationId = metadata?.correlationId || `task-${Date.now()}`;
      const query = payload?.query || payload?.parameters?.query;

      // Log user context for debugging
      console.log('[Subscriber] User context:', {
        isAuthenticated: userContext.isAuthenticated,
        fullName: userContext.fullName || 'Guest',
        email: userContext.email ? '***@***' : 'None',
      });

      if (!query) {
        console.warn('[Subscriber] No query in message, acking anyway');
        message.ack();
        return;
      }

      // Publish streaming start event
      await this.publisher.publishStreamUpdate({
        correlationId,
        sessionId,
        userId,
        eventType: 'router.start',
        stepNumber: 1,
        message: 'Starting task processing...',
      });

      // Process with LangGraph
      try {
        const graph = await createAgentGraph();
        const config = {
          configurable: {
            thread_id: sessionId,
            user_id: userId,
          },
        };

        // Log thread_id for debugging conversation memory
        if (sessionId) {
          console.log(`[Subscriber] ✓ Processing with thread_id: ${sessionId}`);
        } else {
          console.warn(`[Subscriber] ⚠️  No sessionId in message - thread_id will be undefined!`);
        }

        let stepNumber = 1;

        // Track messageIds for each node to separate concurrent streams
        const messageIds = new Map<string, string>();
        const chatModelNodes = new Set<string>(); // Track which nodes are chat models

        // Use streamEvents() to get token-level streaming from LLM
        const streamEvents = graph.streamEvents(
          {
            message: query,
            toolResults: {},
            retryCount: 0,
            maxRetries: 3,
            metadata: {
              sessionId,
              userId,
              correlationId,
              userContext,
            },
          },
          {
            ...config,
            version: 'v2',
          }
        );

        // Stream events - capture LLM tokens with messageId tracking
        for await (const event of streamEvents) {
          const { event: eventType, data, name } = event;

          // Track when chat model starts streaming - generate unique messageId
          if (eventType === 'on_chat_model_start') {
            const messageId = randomUUID();
            messageIds.set(name, messageId);
            chatModelNodes.add(name);
            console.log(`[Subscriber] Chat model started: ${name} with messageId: ${messageId}`);
          }

          // Capture LLM token chunks from all nodes (including generate_status)
          // Each chunk includes messageId to separate concurrent streams
          if (eventType === 'on_chat_model_stream') {
            const chunk = data?.chunk?.content;
            if (chunk && typeof chunk === 'string') {
              const messageId = messageIds.get(name);

              // Publish text chunk in real-time with messageId
              await this.publisher.publishTextChunk({
                correlationId,
                sessionId,
                userId,
                chunk,
                nodeId: name,
                messageId, // Include messageId to separate concurrent streams
              });
            }
          }

          // When chat model ends, publish completion marker
          if (eventType === 'on_chat_model_end' && chatModelNodes.has(name)) {
            const messageId = messageIds.get(name);
            console.log(`[Subscriber] Chat model ended: ${name} with messageId: ${messageId}`);

            // Publish completion marker to signal frontend to finalize this message
            await this.publisher.publishTextChunk({
              correlationId,
              sessionId,
              userId,
              chunk: '',
              nodeId: name,
              messageId,
              isComplete: true,
            });

            // Clean up
            messageIds.delete(name);
            chatModelNodes.delete(name);
          }

          // Capture node execution for progress tracking
          if (eventType === 'on_chain_start') {
            await this.publisher.publishStreamUpdate({
              correlationId,
              sessionId,
              userId,
              eventType: 'node.start',
              stepNumber: stepNumber++,
              message: `Starting ${name}...`,
              data: { name },
            });
          }

          if (eventType === 'on_chain_end') {
            await this.publisher.publishStreamUpdate({
              correlationId,
              sessionId,
              userId,
              eventType: 'node.end',
              stepNumber: stepNumber++,
              message: `Completed ${name}`,
              data: { name },
            });
          }
        }

        // Get final state
        const finalState = await graph.getState(config);
        const result = finalState.values || {};

        // Publish final response
        await this.publisher.publishTaskResponse({
          correlationId,
          sessionId,
          userId,
          status: 'success',
          result: {
            response: result.messages?.[result.messages.length - 1]?.content || 'Task completed',
            data: result,
          },
        });

        message.ack();
        console.log('[Subscriber] ✓ Task completed:', correlationId);
      } catch (graphError) {
        console.error('[Subscriber] Graph execution error:', graphError);

        // Publish error response
        await this.publisher.publishTaskResponse({
          correlationId,
          sessionId,
          userId,
          status: 'error',
          error: {
            message: graphError.message,
            stack: graphError.stack,
          },
        });

        message.ack(); // Ack even on error to avoid redelivery
      }
    } catch (error) {
      console.error('[Subscriber] Message handling error:', error);
      message.nack(); // Nack to retry
    }
  }

  /**
   * Stop subscriber
   */
  async stop(): Promise<void> {
    if (this.subscription) {
      await this.subscription.close();
      console.log('[Subscriber] Stopped');
    }
  }
}
