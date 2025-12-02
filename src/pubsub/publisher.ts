/**
 * Pub/Sub Publishers for LangGraph Agent
 * Publishes agent responses and streaming events
 */

import { PubSub, PublishOptions, Topic } from '@google-cloud/pubsub';
import { reportPubSubError, reportPubSubSuccess } from './shared.js';

// Topic cache with TTL to prevent stale topics
interface CachedTopic {
  topic: Topic;
  createdAt: number;
}

const TOPIC_CACHE_TTL_MS = 60 * 1000; // Refresh topic references every 60s

export class AgentPublisher {
  private topicCache: Map<string, CachedTopic> = new Map();

  constructor(
    private pubsub: PubSub,
    private publishOptions?: PublishOptions
  ) {}

  /**
   * Get topic with caching and Cloud Run optimized settings
   * Refreshes topic references periodically to avoid stale gRPC streams
   */
  private getTopic(topicName: string): Topic {
    const cached = this.topicCache.get(topicName);
    const now = Date.now();

    // Return cached topic if still fresh
    if (cached && (now - cached.createdAt) < TOPIC_CACHE_TTL_MS) {
      return cached.topic;
    }

    // Create new topic reference with publish options
    const topic = this.publishOptions
      ? this.pubsub.topic(topicName, this.publishOptions)
      : this.pubsub.topic(topicName);

    this.topicCache.set(topicName, { topic, createdAt: now });
    return topic;
  }

  /**
   * Publish agent task response (final result)
   * Non-blocking: catches timeout errors to prevent agent crashes
   */
  async publishTaskResponse(data: {
    correlationId: string;
    sessionId: string;
    userId?: string;
    status: 'success' | 'error';
    result?: any;
    error?: any;
  }): Promise<void> {
    try {
      const topic = this.getTopic('agent.task.response');

      const message = {
        type: 'agent.task.response',
        timestamp: new Date().toISOString(),
        source: 'agent',
        sessionId: data.sessionId,
        userId: data.userId,
        payload: {
          status: data.status,
          result: data.result,
          error: data.error,
        },
        metadata: {
          correlationId: data.correlationId,
        },
      };

      await topic.publishMessage({ json: message });
      reportPubSubSuccess();
      console.log(`[Publisher] Published task response: ${data.correlationId}`);
    } catch (error) {
      // Non-blocking: Don't crash agent on Pub/Sub timeouts
      reportPubSubError();
      console.warn('[Publisher] Failed to publish task response (non-fatal):', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Publish streaming update
   * Non-blocking: catches timeout errors to prevent agent crashes
   */
  async publishStreamUpdate(data: {
    correlationId: string;
    sessionId: string;
    userId?: string;
    eventType: string;
    stepNumber: number;
    message?: string;
    data?: any;
  }): Promise<void> {
    try {
      const topic = this.getTopic('agent.streaming.update');

      const message = {
        type: 'agent.streaming.update',
        timestamp: new Date().toISOString(),
        source: 'agent',
        sessionId: data.sessionId,
        userId: data.userId,
        payload: {
          eventType: data.eventType,
          stepNumber: data.stepNumber,
          message: data.message,
          data: data.data,
        },
        metadata: {
          correlationId: data.correlationId,
        },
      };

      await topic.publishMessage({ json: message });
      reportPubSubSuccess();
      console.log(`[Publisher] Published stream update: ${data.eventType}`);
    } catch (error) {
      // Non-blocking: Don't crash agent on Pub/Sub timeouts
      reportPubSubError();
      console.warn('[Publisher] Failed to publish stream update (non-fatal):', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Publish LLM text chunk (real token streaming)
   */
  async publishTextChunk(data: {
    correlationId: string;
    sessionId: string;
    userId?: string;
    chunk: string;
    nodeId?: string;
    messageId?: string;  // Unique ID to separate concurrent streams
    isComplete?: boolean;
  }): Promise<void> {
    try {
      // Get topic reference with Cloud Run optimized settings
      const topic = this.getTopic('agent.text.stream');

      const message = {
        type: 'agent.text.stream',
        timestamp: new Date().toISOString(),
        source: 'agent',
        sessionId: data.sessionId,
        userId: data.userId,
        payload: {
          chunk: data.chunk,
          nodeId: data.nodeId,
          messageId: data.messageId,  // Include messageId for frontend routing
          isComplete: data.isComplete || false,
        },
        metadata: {
          correlationId: data.correlationId,
        },
      };

      await topic.publishMessage({ json: message });
      reportPubSubSuccess(); // Track success for adaptive client recreation
      // Log first chunk and completion markers for debugging
      if (data.isComplete || data.chunk.length < 10) {
        console.log(`[Publisher] Published text chunk: messageId=${data.messageId}, nodeId=${data.nodeId}, isComplete=${data.isComplete}, chunk="${data.chunk.substring(0, 30)}"`);
      }
    } catch (error) {
      // Non-blocking: Don't fail agent execution if chunk publishing fails
      // This can happen due to Pub/Sub client caching or topic not existing yet
      reportPubSubError(); // Track error for adaptive client recreation
      console.warn('[Publisher] Failed to publish text chunk (non-fatal):', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Publish tool status message
   * Used by generate-status node to send user-friendly tool execution updates
   */
  async publishToolStatus(data: {
    correlationId: string;
    sessionId: string;
    userId?: string;
    toolName: string;
    toolCallId: string;
    statusMessage: string;
  }): Promise<void> {
    try {
      const topic = this.getTopic('agent.text.stream');

      const message = {
        type: 'agent.text.stream',
        timestamp: new Date().toISOString(),
        source: 'agent',
        sessionId: data.sessionId,
        userId: data.userId,
        payload: {
          chunk: data.statusMessage,
          nodeId: `tool_status_${data.toolName}`,
          metadata: {
            type: 'tool_status',
            toolName: data.toolName,
            toolCallId: data.toolCallId,
          },
        },
        metadata: {
          correlationId: data.correlationId,
        },
      };

      await topic.publishMessage({ json: message });
      console.log(`[Publisher] Published tool status for ${data.toolName}`);
    } catch (error) {
      console.warn('[Publisher] Failed to publish tool status (non-fatal):', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Publish progress status update (for real-time "thinking" indicator)
   * Shows concise status messages that update in place on the frontend
   */
  async publishProgressUpdate(data: {
    sessionId: string;
    userId?: string;
    correlationId?: string;
    status: string;  // Concise status (max 10 words): "Analyzing query...", "Filtering 50 properties..."
  }): Promise<void> {
    try {
      const topic = this.getTopic('agent.progress.update');

      const message = {
        type: 'agent.progress.update',
        timestamp: new Date().toISOString(),
        source: 'agent',
        sessionId: data.sessionId,
        userId: data.userId,
        payload: {
          status: data.status,
        },
        metadata: {
          correlationId: data.correlationId || `progress-${Date.now()}`,
        },
      };

      await topic.publishMessage({ json: message });
      reportPubSubSuccess();
      console.log(`[Publisher] Progress: ${data.status}`);
    } catch (error) {
      // Non-fatal - don't block execution
      reportPubSubError();
      console.warn('[Publisher] Failed to publish progress (non-fatal):', error instanceof Error ? error.message : String(error));
    }
  }
}
