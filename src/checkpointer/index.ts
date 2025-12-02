import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { MemorySaver, BaseCheckpointSaver } from "@langchain/langgraph";
import type { CheckpointMetadata, CheckpointTuple, PendingWrite } from "@langchain/langgraph-checkpoint";
import { config } from "../config/index.js";

/**
 * PostgreSQL Checkpointer with Cloud Run resilience
 *
 * Provides persistent checkpoint storage for LangGraph agents.
 * Handles Cloud Run cold starts and connection recovery.
 *
 * CRITICAL FIX: Wraps PostgresSaver to catch runtime write errors
 * that would otherwise crash the container.
 */

let checkpointerInstance: ResilientPostgresSaver | null = null;
let memoryFallback: MemorySaver | null = null;
let lastConnectionAttempt: number = 0;
const CONNECTION_RETRY_INTERVAL = 30000; // 30 seconds between retry attempts

/**
 * Resilient PostgreSQL Saver - wraps PostgresSaver to catch runtime errors
 *
 * When PostgreSQL connection fails during writes, logs error but doesn't crash.
 * This is critical for Cloud Run where connections can become stale.
 */
class ResilientPostgresSaver extends BaseCheckpointSaver {
  private postgres: PostgresSaver;
  private errorCount: number = 0;
  private readonly maxErrorsBeforeFallback = 3;

  constructor(postgres: PostgresSaver) {
    super();
    this.postgres = postgres;
  }

  async getTuple(config: any): Promise<CheckpointTuple | undefined> {
    try {
      return await this.postgres.getTuple(config);
    } catch (error) {
      console.error('[ResilientCheckpointer] getTuple error (non-fatal):', error.message);
      this.errorCount++;
      return undefined;
    }
  }

  async *list(config: any, options?: any): AsyncGenerator<CheckpointTuple> {
    try {
      for await (const tuple of this.postgres.list(config, options)) {
        yield tuple;
      }
    } catch (error) {
      console.error('[ResilientCheckpointer] list error (non-fatal):', error.message);
      this.errorCount++;
      // Return empty generator on error
    }
  }

  async put(config: any, checkpoint: any, metadata: CheckpointMetadata, newVersions: any): Promise<any> {
    try {
      return await this.postgres.put(config, checkpoint, metadata, newVersions);
    } catch (error) {
      console.error('[ResilientCheckpointer] put error (non-fatal):', error.message);
      this.errorCount++;
      // Return a minimal response to prevent crash
      return {
        configurable: config.configurable || {},
      };
    }
  }

  async putWrites(config: any, writes: PendingWrite[], taskId: string): Promise<void> {
    try {
      await this.postgres.putWrites(config, writes, taskId);
    } catch (error) {
      // This is the critical error that was crashing containers
      console.error('[ResilientCheckpointer] putWrites error (non-fatal):', error.message);
      this.errorCount++;
      // Don't rethrow - allow graph execution to continue
    }
  }

  async get(config: any): Promise<any> {
    try {
      return await this.postgres.get(config);
    } catch (error) {
      console.error('[ResilientCheckpointer] get error (non-fatal):', error.message);
      this.errorCount++;
      return undefined;
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    try {
      await this.postgres.deleteThread(threadId);
    } catch (error) {
      console.error('[ResilientCheckpointer] deleteThread error (non-fatal):', error.message);
      this.errorCount++;
      // Don't rethrow
    }
  }

  hasExcessiveErrors(): boolean {
    return this.errorCount >= this.maxErrorsBeforeFallback;
  }

  resetErrorCount(): void {
    this.errorCount = 0;
  }
}

/**
 * Create PostgreSQL checkpointer with connection pool settings optimized for Cloud Run
 */
async function createPostgresCheckpointer(): Promise<PostgresSaver> {
  // Add connection pool settings optimized for Cloud Run
  // - Longer idle timeout prevents premature connection drops
  // - TCP keep-alive detects stale connections before errors
  const connectionString = config.database.url;

  // Parse and add pool configuration
  const url = new URL(connectionString);
  url.searchParams.set('connection_limit', '3');
  url.searchParams.set('pool_timeout', '10');
  url.searchParams.set('idle_timeout', '600');  // 10 minutes (was 30s) - Cloud Run containers can be idle
  url.searchParams.set('connect_timeout', '10');

  // TCP Keep-Alive settings - detect stale connections before they cause errors
  url.searchParams.set('keepalives', '1');
  url.searchParams.set('keepalives_idle', '30');     // Start probing after 30s idle
  url.searchParams.set('keepalives_interval', '10'); // Probe every 10s
  url.searchParams.set('keepalives_count', '5');     // Give up after 5 failed probes

  const checkpointer = PostgresSaver.fromConnString(url.toString());
  await checkpointer.setup();

  return checkpointer;
}

/**
 * Create and initialize PostgreSQL checkpointer with fallback to memory
 */
export async function createCheckpointer(): Promise<BaseCheckpointSaver> {
  // If we have a working postgres instance with no excessive errors, return it
  if (checkpointerInstance && !checkpointerInstance.hasExcessiveErrors()) {
    return checkpointerInstance;
  }

  // If postgres had too many errors, reset and try again
  if (checkpointerInstance && checkpointerInstance.hasExcessiveErrors()) {
    console.log('[Checkpointer] PostgreSQL had excessive errors, will recreate connection');
    checkpointerInstance = null;
  }

  // If postgres failed recently, use memory fallback
  const now = Date.now();
  if (memoryFallback && (now - lastConnectionAttempt) < CONNECTION_RETRY_INTERVAL) {
    console.log('[Checkpointer] Using memory fallback (postgres cooldown)');
    return memoryFallback;
  }

  console.log('[Checkpointer] Initializing PostgreSQL checkpointer...');
  lastConnectionAttempt = now;

  try {
    const postgres = await createPostgresCheckpointer();
    checkpointerInstance = new ResilientPostgresSaver(postgres);
    console.log('[Checkpointer] ✓ PostgreSQL checkpointer initialized (with resilience wrapper)');
    return checkpointerInstance;
  } catch (error) {
    console.error('[Checkpointer] ✗ PostgreSQL failed, using memory fallback:', error);

    // Create memory fallback if not exists
    if (!memoryFallback) {
      memoryFallback = new MemorySaver();
      console.log('[Checkpointer] ✓ Memory fallback initialized');
    }

    // Clear failed postgres instance
    checkpointerInstance = null;

    return memoryFallback;
  }
}

/**
 * Reset the checkpointer (call on connection errors)
 */
export function resetCheckpointer(): void {
  console.log('[Checkpointer] Resetting connection...');
  checkpointerInstance = null;
}

/**
 * Get the existing checkpointer instance (postgres or memory fallback)
 */
export function getCheckpointer(): BaseCheckpointSaver {
  if (checkpointerInstance) {
    return checkpointerInstance;
  }
  if (memoryFallback) {
    return memoryFallback;
  }
  throw new Error('Checkpointer not initialized. Call createCheckpointer() first.');
}

/**
 * Close the checkpointer connection
 */
export async function closeCheckpointer(): Promise<void> {
  checkpointerInstance = null;
  memoryFallback = null;
  console.log('[Checkpointer] ✓ Checkpointer connections cleared');
}
