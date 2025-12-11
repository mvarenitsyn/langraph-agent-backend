/**
 * Pub/Sub Subscriber for LangGraph Agent
 * Listens to agent.task.request and processes with graph
 */

import { PubSub, Message } from '@google-cloud/pubsub';
import { randomUUID } from 'crypto';
import { AgentPublisher } from './publisher.js';
import { createAgentGraph } from '../graph/index.js';
import { resolvePlatformContext } from '../utils/platformContext.js';
import { PlatformType } from '../types/platform.js';

interface TokenBuffer {
  chunks: string[];
  timer: NodeJS.Timeout | null;
  metadata: {
    correlationId: string;
    sessionId: string;
    userId: string;
    nodeId: string;
    messageId: string;
  };
}

export class AgentSubscriber {
  private publisher: AgentPublisher;
  private subscription: any;
  private tokenBuffers: Map<string, TokenBuffer> = new Map();
  private readonly BUFFER_MAX_TOKENS = 10;      // Flush after 10 tokens
  private readonly BUFFER_MAX_DELAY_MS = 50;    // Or flush after 50ms

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
      console.log('[Subscriber] ====== DEBUG: Full Pub/Sub Message ======');
      console.log('[Subscriber] Raw message data:', JSON.stringify(data, null, 2));

      // Fallback defaults for direct testing (curl without full payload)
      const TEST_FALLBACKS = {
        searchId: '088d4b7f-016b-480f-abd5-92d5b9cca85f',  // Default test searchId for follow-up testing
        userId: '12345678',  // Default test userId
        sessionId: `test-session-${Date.now()}`,  // Generate unique session for each test
        userContext: {
          isAuthenticated: true,
          fullName: 'Test User',
          email: 'test@example.com',
          userId: '12345678',
          linkedListingsCount: 6,
          collectionsCount: 10,
        }
      };

      const {
        payload,
        sessionId = TEST_FALLBACKS.sessionId,
        userId = TEST_FALLBACKS.userId,
        metadata,
      } = data;

      console.log('[Subscriber] ====== DEBUG: Extracted Fields ======');
      console.log('[Subscriber] sessionId:', sessionId);
      console.log('[Subscriber] userId:', userId);
      console.log('[Subscriber] metadata:', JSON.stringify(metadata, null, 2));
      console.log('[Subscriber] payload:', JSON.stringify(payload, null, 2));

      // Extract user context from payload with TEST_FALLBACKS as default
      const userContext = payload?.userContext || TEST_FALLBACKS.userContext;

      const correlationId = metadata?.correlationId || `task-${Date.now()}`;
      // Support both 'query' and 'message' field names for compatibility
      const query = payload?.query || payload?.message || payload?.parameters?.query;
      // Only use explicit searchId from payload (no fallback to prevent incorrect routing)
      const searchId = payload?.searchId || payload?.parameters?.searchId;

      console.log('[Subscriber] ====== DEBUG: Query & SearchId Extraction ======');
      console.log('[Subscriber] query:', query);
      console.log('[Subscriber] payload.searchId:', payload?.searchId || 'NOT FOUND');
      console.log('[Subscriber] payload.parameters:', JSON.stringify(payload?.parameters || {}, null, 2));
      console.log('[Subscriber] payload.parameters.searchId:', payload?.parameters?.searchId || 'NOT FOUND');
      console.log('[Subscriber] FINAL searchId:', searchId || 'NONE');

      // Log user context for debugging
      console.log('[Subscriber] ====== DEBUG: UserContext Extraction ======');
      console.log('[Subscriber] payload.userContext exists?', !!payload?.userContext);
      console.log('[Subscriber] Extracted userContext:', JSON.stringify(userContext, null, 2));
      console.log('[Subscriber] User context summary:', {
        isAuthenticated: userContext.isAuthenticated,
        fullName: userContext.fullName || 'Guest',
        email: userContext.email ? '***@***' : 'None',
      });

      // Extract and resolve platform context
      const platformRaw = payload?.platform || metadata?.platform || 'web';
      const platformContext = resolvePlatformContext({ platform: platformRaw as PlatformType });
      console.log('[Subscriber] ====== DEBUG: PlatformContext Extraction ======');
      console.log('[Subscriber] Platform:', platformContext.platform);
      console.log('[Subscriber] Supports Rich UI:', platformContext.capabilities.supportsRichUI);
      console.log('[Subscriber] Max Message Length:', platformContext.capabilities.maxMessageLength);

      if (!query) {
        console.warn('[Subscriber] No query in message, acking anyway');
        message.ack();
        return;
      }

      // Emit progress: Processing query
      await this.publisher.publishProgressUpdate({
        sessionId,
        userId,
        correlationId,
        status: 'Processing query...',
      });

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
        console.log('[Subscriber] ====== THREAD ID DEBUG ======');
        console.log(`[Subscriber] thread_id: ${sessionId || 'UNDEFINED'}`);
        console.log(`[Subscriber] userId: ${userId || 'UNDEFINED'}`);
        console.log(`[Subscriber] correlationId: ${correlationId}`);

        if (sessionId) {
          console.log(`[Subscriber] ✓ Checkpointer will load/save conversation for: ${sessionId}`);
        } else {
          console.warn(`[Subscriber] ⚠️  WARNING: No sessionId - conversation will NOT persist!`);
        }

        console.log('[Subscriber] ============================');

        let stepNumber = 1;

        // Track messageIds for each node to separate concurrent streams
        const messageIds = new Map<string, string>();
        const chatModelNodes = new Set<string>(); // Track which nodes are chat models
        let tokensStreamed = false; // Track if any tokens were streamed

        // Prepare initial state
        const initialState = {
          message: query,
          toolResults: {},
          retryCount: 0,
          maxRetries: 3,
          metadata: {
            sessionId,
            userId,
            correlationId,
            userContext,
            searchId: searchId || undefined,      // ✅ Current search ID (from parameters or latest property_search)
            incomingSearchId: searchId || undefined,  // 🚨 FIX: Fresh searchId that won't be overwritten by checkpoint
            lastSearchId: undefined,              // Previous search ID (for reference)
            platform: platformContext.platform,   // Platform identifier for downstream nodes
          },
          platformContext,  // Platform context for platform-aware behavior
        };

        console.log('[Subscriber] ====== DEBUG: Graph Invocation ======');
        console.log('[Subscriber] Initial state being passed to graph:', JSON.stringify(initialState, null, 2));
        console.log('[Subscriber] Config being passed to graph:', JSON.stringify(config, null, 2));

        // Check if checkpointer will load previous state
        try {
          const checkpointer = graph.checkpointer;
          if (checkpointer && checkpointer !== true && sessionId) {
            console.log('[Subscriber] ✓ Checkpointer is configured - attempting to load previous state...');
            const checkpoint = await checkpointer.get({ configurable: { thread_id: sessionId } });
            if (checkpoint) {
              console.log('[Subscriber] ✓ Found checkpoint for this thread_id!');
              console.log(`[Subscriber] Checkpoint channel values:`, Object.keys(checkpoint.channel_values));
              if (checkpoint.channel_values.messages && Array.isArray(checkpoint.channel_values.messages)) {
                console.log(`[Subscriber] Previous message count: ${(checkpoint.channel_values.messages as any[]).length}`);
              }
            } else {
              console.log('[Subscriber] No previous checkpoint found - this is a new conversation');
            }
          } else {
            console.log('[Subscriber] ⚠️  Checkpointer not configured or no sessionId');
          }
        } catch (checkpointError) {
          console.log('[Subscriber] Could not check previous state:', checkpointError.message);
        }
        console.log('[Subscriber] =======================================');

        // Use streamEvents() to get token-level streaming from LLM
        const streamEvents = graph.streamEvents(
          initialState,
          {
            ...config,
            version: 'v2',
          }
        );

        // Stream events - capture LLM tokens with messageId tracking
        // Use run_id (unique per LLM invocation) as key instead of model name
        // This prevents collision when multiple nodes use the same model class
        for await (const event of streamEvents) {
          const { event: eventType, data, name, run_id } = event as any;

          // Track when chat model starts streaming - generate unique messageId
          // Use run_id as key to avoid collisions when multiple nodes use same model
          if (eventType === 'on_chat_model_start') {
            const messageId = randomUUID();
            const streamKey = run_id || name; // Fallback to name if run_id not available
            messageIds.set(streamKey, messageId);
            chatModelNodes.add(streamKey);
            console.log(`[Subscriber] Chat model started: ${name} (run_id: ${run_id}) with messageId: ${messageId}`);
          }

          // Capture LLM token chunks from all nodes (including generate_status)
          // Each chunk includes messageId to separate concurrent streams
          if (eventType === 'on_chat_model_stream') {
            const chunk = data?.chunk?.content;
            if (chunk && typeof chunk === 'string') {
              const streamKey = run_id || name;
              const messageId = messageIds.get(streamKey);
              tokensStreamed = true; // Mark that we've streamed tokens

              // Buffer tokens for batched publishing (improves streaming performance)
              await this.bufferToken(messageId, chunk, {
                correlationId,
                sessionId,
                userId,
                nodeId: name,
                messageId,
              });
            }
          }

          // When chat model ends, publish completion marker
          const streamKeyForEnd = run_id || name;
          if (eventType === 'on_chat_model_end' && chatModelNodes.has(streamKeyForEnd)) {
            const messageId = messageIds.get(streamKeyForEnd);
            console.log(`[Subscriber] Chat model ended: ${name} (run_id: ${run_id}) with messageId: ${messageId}`);

            // Flush any remaining buffered tokens before completing
            await this.flushTokenBuffer(messageId);

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

            // Clean up using streamKey (run_id or name)
            messageIds.delete(streamKeyForEnd);
            chatModelNodes.delete(streamKeyForEnd);
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

        // 🚨 FIX: If no tokens were streamed but we have a finalResponse (e.g., router direct response),
        // publish it as a text chunk so the frontend displays it
        if (!tokensStreamed && result.finalResponse) {
          console.log('[Subscriber] No tokens streamed but finalResponse exists - publishing as text chunk');
          const directResponseMessageId = randomUUID();

          // Publish the full response as a single text chunk
          await this.publisher.publishTextChunk({
            correlationId,
            sessionId,
            userId,
            chunk: result.finalResponse,
            nodeId: 'router',
            messageId: directResponseMessageId,
          });

          // Publish completion marker
          await this.publisher.publishTextChunk({
            correlationId,
            sessionId,
            userId,
            chunk: '',
            nodeId: 'router',
            messageId: directResponseMessageId,
            isComplete: true,
          });

          console.log(`[Subscriber] Published direct response: "${result.finalResponse.substring(0, 100)}..."`);
        }

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
   * Buffer token for batched publishing (performance optimization)
   * Accumulates tokens and publishes in batches to reduce Pub/Sub overhead
   */
  private async bufferToken(
    messageId: string,
    chunk: string,
    metadata: {
      correlationId: string;
      sessionId: string;
      userId: string;
      nodeId: string;
      messageId: string;
    }
  ): Promise<void> {
    // Initialize buffer for this message if it doesn't exist
    if (!this.tokenBuffers.has(messageId)) {
      this.tokenBuffers.set(messageId, {
        chunks: [],
        timer: null,
        metadata,
      });
    }

    const buffer = this.tokenBuffers.get(messageId)!;
    buffer.chunks.push(chunk);

    // Clear existing timer if any
    if (buffer.timer) {
      clearTimeout(buffer.timer);
    }

    // Flush immediately if we've accumulated enough tokens
    if (buffer.chunks.length >= this.BUFFER_MAX_TOKENS) {
      await this.flushTokenBuffer(messageId);
    } else {
      // Otherwise, set timer to flush after delay
      buffer.timer = setTimeout(() => {
        this.flushTokenBuffer(messageId).catch(err => {
          console.error('[Subscriber] Error flushing token buffer:', err);
        });
      }, this.BUFFER_MAX_DELAY_MS);
    }
  }

  /**
   * Flush buffered tokens to Pub/Sub
   */
  private async flushTokenBuffer(messageId: string): Promise<void> {
    const buffer = this.tokenBuffers.get(messageId);
    if (!buffer || buffer.chunks.length === 0) {
      return;
    }

    // Clear timer BEFORE flushing to prevent re-entry
    if (buffer.timer) {
      clearTimeout(buffer.timer);
      buffer.timer = null;
    }

    // Store chunks and metadata, then IMMEDIATELY clear buffer to prevent re-entry
    const chunksToFlush = [...buffer.chunks];
    const metadata = buffer.metadata;
    this.tokenBuffers.delete(messageId);  // ← CRITICAL: Delete BEFORE publish to prevent duplication

    // Combine all buffered chunks
    const combinedChunk = chunksToFlush.join('');
    const tokenCount = chunksToFlush.length;

    // Publish batched chunk
    await this.publisher.publishTextChunk({
      ...metadata,
      chunk: combinedChunk,
    });

    console.log(`[Subscriber] Flushed ${tokenCount} tokens (${combinedChunk.length} chars) for messageId: ${messageId}`);
  }

  /**
   * Stop subscriber
   */
  async stop(): Promise<void> {
    // Flush all pending buffers before stopping
    const flushPromises = Array.from(this.tokenBuffers.keys()).map(messageId =>
      this.flushTokenBuffer(messageId)
    );
    await Promise.all(flushPromises);

    if (this.subscription) {
      await this.subscription.close();
      console.log('[Subscriber] Stopped');
    }
  }
}
