/**
 * Pub/Sub Publishers for LangGraph Agent
 * Publishes agent responses and streaming events
 */

import { PubSub } from '@google-cloud/pubsub';

export class AgentPublisher {
  constructor(private pubsub: PubSub) {}

  /**
   * Publish agent task response (final result)
   */
  async publishTaskResponse(data: {
    correlationId: string;
    sessionId: string;
    userId?: string;
    status: 'success' | 'error';
    result?: any;
    error?: any;
  }): Promise<void> {
    const topic = this.pubsub.topic('agent.task.response');

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
    console.log(`[Publisher] Published task response: ${data.correlationId}`);
  }

  /**
   * Publish streaming update
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
    const topic = this.pubsub.topic('agent.streaming.update');

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
    console.log(`[Publisher] Published stream update: ${data.eventType}`);
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
      // Get topic reference without metadata caching
      const topic = this.pubsub.topic('agent.text.stream');

      // Ensure topic exists (bypasses cache issues)
      const [exists] = await topic.exists();
      if (!exists) {
        console.log('[Publisher] Creating agent.text.stream topic...');
        await topic.create();
      }

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
      // Log first chunk and completion markers for debugging
      if (data.isComplete || data.chunk.length < 10) {
        console.log(`[Publisher] Published text chunk: messageId=${data.messageId}, nodeId=${data.nodeId}, isComplete=${data.isComplete}, chunk="${data.chunk.substring(0, 30)}"`);
      }
    } catch (error) {
      // Non-blocking: Don't fail agent execution if chunk publishing fails
      // This can happen due to Pub/Sub client caching or topic not existing yet
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
      const topic = this.pubsub.topic('agent.text.stream');

      // Ensure topic exists
      const [exists] = await topic.exists();
      if (!exists) {
        console.log('[Publisher] Creating agent.text.stream topic...');
        await topic.create();
      }

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
}
