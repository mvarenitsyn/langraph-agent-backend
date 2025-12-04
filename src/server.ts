import express, { Request, Response } from 'express';
import { HumanMessage } from "@langchain/core/messages";
import { randomUUID } from 'crypto';
import { config, validateConfig } from './config/index.js';
import { initializeTools } from './tools/index.js';
import { createAgentGraph } from './graph/index.js';
import { PubSub } from '@google-cloud/pubsub';
import { AgentSubscriber } from './pubsub/subscriber.js';
import {
  createSSEMessage,
  createStepStartEvent,
  createStepEndEvent,
  createFinalEvent,
  createErrorEvent
} from './utils/streaming.js';
import { getSearchResults, getSearchMetadata } from './subgraphs/property-search/db/search-results.js';
import { resolvePlatformContext } from './utils/platformContext.js';
import { PlatformType } from './types/platform.js';

/**
 * Express Server with Streaming Support
 */

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
  });
});

/**
 * Main chat endpoint with streaming
 */
app.post('/chat', async (req: Request, res: Response) => {
  // Support both 'message' (new) and 'query' (backward compatibility)
  const { message, query, threadId = 'default-thread', platform = 'web' } = req.body;
  const userMessage = message || query;

  if (!userMessage) {
    res.status(400).json({ error: 'Message is required' });
    return;
  }

  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const startTime = Date.now();
  let stepNumber = 0;

  try {
    // Initialize agent graph
    const graph = await createAgentGraph();

    // Configure thread for checkpointing
    const configurable = { configurable: { thread_id: threadId } };

    // Resolve platform context from request
    const platformContext = resolvePlatformContext({ platform: platform as PlatformType });
    console.log(`[Server] Platform: ${platformContext.platform}`);

    // Stream the graph execution
    // Note: Only pass fields that need to be set for this turn
    // LangGraph will automatically load messages from checkpoint
    const stream = await graph.stream(
      {
        message: userMessage,
        // Don't reset messages - let LangGraph load from checkpoint
        toolResults: {},
        metadata: {
          sessionId: threadId,
          userId: req.body.userId, // Optional: can be passed from client
          correlationId: randomUUID(),
          platform: platformContext.platform,
        },
        platformContext,
      },
      {
        ...configurable,
        streamMode: 'values',
      }
    );

    // Process stream
    for await (const chunk of stream) {
      stepNumber++;

      // Type chunk as any to avoid Uint8Array inference
      const stateChunk = chunk as any;

      // Get the current node name (last key in chunk)
      const nodeNames = Object.keys(stateChunk);
      const currentNode = nodeNames[nodeNames.length - 1] || 'unknown';

      // Send step start event
      const stepStartEvent = createStepStartEvent(currentNode, stepNumber, {
        message: stateChunk.message || '',
        retryCount: stateChunk.retryCount || 0,
      });
      res.write(createSSEMessage(stepStartEvent));

      // Send step end event (with minimal delay for demo)
      setTimeout(() => {
        const stepEndEvent = createStepEndEvent(
          currentNode,
          stepNumber,
          100, // Approximate duration
          { completed: true }
        );
        res.write(createSSEMessage(stepEndEvent));
      }, 100);

      // Check if we have a final response
      if (stateChunk.finalResponse) {
        const totalDuration = Date.now() - startTime;
        const finalEvent = createFinalEvent(
          stateChunk.finalResponse,
          stepNumber,
          totalDuration
        );
        res.write(createSSEMessage(finalEvent));
      }
    }

    // Close the stream
    res.end();
  } catch (error) {
    console.error('[Server] Error:', error);
    const errorEvent = createErrorEvent(
      error instanceof Error ? error.message : 'Unknown error'
    );
    res.write(createSSEMessage(errorEvent));
    res.end();
  }
});

/**
 * Non-streaming chat endpoint
 */
app.post('/chat/simple', async (req: Request, res: Response) => {
  // Support both 'message' (new) and 'query' (backward compatibility)
  const { message, query, threadId = 'default-thread', metadata: clientMetadata, platform = 'web' } = req.body;
  const userMessage = message || query;

  if (!userMessage) {
    res.status(400).json({ error: 'Message is required' });
    return;
  }

  try {
    const graph = await createAgentGraph();
    const configurable = { configurable: { thread_id: threadId } };

    // Resolve platform context from request
    const platformContext = resolvePlatformContext({ platform: platform as PlatformType });
    console.log(`[Server] Platform: ${platformContext.platform}`);

    // Note: Only pass fields that need to be set for this turn
    // LangGraph will automatically load messages from checkpoint
    const result = await graph.invoke(
      {
        message: userMessage,
        // Don't reset messages - let LangGraph load from checkpoint
        toolResults: {},
        metadata: {
          sessionId: threadId,
          userId: req.body.userId, // Optional: can be passed from client
          correlationId: randomUUID(),
          platform: platformContext.platform,
          // Merge client-provided metadata (e.g., searchId for testing)
          ...(clientMetadata || {}),
        },
        platformContext,
      },
      configurable
    );

    res.json({
      success: true,
      response: result.finalResponse,
      threadId,
      metadata: result.metadata,
    });
  } catch (error) {
    console.error('[Server] Error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get conversation history for a thread
 */
app.get('/history/:threadId', async (req: Request, res: Response) => {
  const { threadId } = req.params;

  try {
    const graph = await createAgentGraph();
    const configurable = { configurable: { thread_id: threadId } };

    const state = await graph.getState(configurable);

    res.json({
      success: true,
      threadId,
      state: state.values,
      nextNodes: state.next,
    });
  } catch (error) {
    console.error('[Server] Error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get search results by searchId
 * Returns properties from PostgreSQL that were saved during search
 */
app.get('/search-results/:searchId', async (req: Request, res: Response) => {
  const { searchId } = req.params;
  const { page = '1', pageSize = '50', sortBy, sortOrder } = req.query;

  try {
    // Get metadata first to verify search exists
    const metadata = await getSearchMetadata(searchId);
    if (!metadata) {
      res.status(404).json({
        success: false,
        error: 'Search not found',
      });
      return;
    }

    // Get results with optional pagination and sorting
    const { results, pageInfo } = await getSearchResults({
      searchId,
      page: parseInt(page as string, 10),
      pageSize: parseInt(pageSize as string, 10),
      sortBy: sortBy as any,
      sortOrder: sortOrder as any,
    });

    res.json({
      success: true,
      searchId,
      query: metadata.queryText,
      totalResults: metadata.totalResults,
      properties: results,
      pageInfo,
      createdAt: metadata.createdAt,
    });
  } catch (error) {
    console.error('[Server] Error fetching search results:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Start the server
 */
async function startServer() {
  try {
    console.log('\n🚀 LangGraph Agent Boilerplate');
    console.log('================================\n');

    // Validate configuration
    validateConfig();
    console.log('✓ Configuration validated');

    // Initialize tools
    initializeTools();

    // Initialize Pub/Sub subscriber
    const pubsub = new PubSub({
      projectId: process.env.GCP_PROJECT_ID || 'myvista-dev',
      ...(process.env.PUBSUB_EMULATOR_HOST && {
        apiEndpoint: process.env.PUBSUB_EMULATOR_HOST
      })
    });

    // Configure batching for text stream topic (performance optimization)
    const textStreamTopic = pubsub.topic('agent.text.stream');
    textStreamTopic.setPublishOptions({
      batching: {
        maxMessages: 100,          // Batch up to 100 messages
        maxMilliseconds: 50,       // Or flush after 50ms
        maxBytes: 1024 * 1024,     // 1MB max batch size
      },
      flowControlOptions: {
        maxOutstandingMessages: 1000,
        maxOutstandingBytes: 10 * 1024 * 1024, // 10MB
      }
    });
    console.log('✓ Pub/Sub batching configured for agent.text.stream');

    const subscriber = new AgentSubscriber(pubsub);
    await subscriber.start();
    console.log('✓ Pub/Sub subscriber initialized');

    // Start server
    app.listen(config.server.port, () => {
      console.log(`\n✓ Server running on http://localhost:${config.server.port}`);
      console.log('\nEndpoints:');
      console.log(`  - POST   /chat          (streaming)`);
      console.log(`  - POST   /chat/simple   (non-streaming)`);
      console.log(`  - GET    /history/:threadId`);
      console.log(`  - GET    /health`);
      console.log('\nExample usage:');
      console.log(`  curl -X POST http://localhost:${config.server.port}/chat/simple \\`);
      console.log(`    -H "Content-Type: application/json" \\`);
      console.log(`    -d '{"message": "Find 3 bedroom homes in San Francisco under $1.5M", "threadId": "user-123"}'`);
      console.log('');
    });
  } catch (error) {
    console.error('✗ Failed to start server:', error);
    process.exit(1);
  }
}

// Start the server
startServer();
