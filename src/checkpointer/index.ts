import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { MemorySaver } from "@langchain/langgraph";
import { config } from "../config/index.js";

/**
 * PostgreSQL Checkpointer with Cloud Run resilience
 *
 * Provides persistent checkpoint storage for LangGraph agents.
 * Handles Cloud Run cold starts and connection recovery.
 */

let checkpointerInstance: PostgresSaver | null = null;
let memoryFallback: MemorySaver | null = null;
let lastConnectionAttempt: number = 0;
const CONNECTION_RETRY_INTERVAL = 30000; // 30 seconds between retry attempts

/**
 * Create PostgreSQL checkpointer with connection pool settings optimized for Cloud Run
 */
async function createPostgresCheckpointer(): Promise<PostgresSaver> {
  // Add connection pool settings to handle Cloud Run scaling
  const connectionString = config.database.url;

  // Parse and add pool configuration
  const url = new URL(connectionString);
  url.searchParams.set('connection_limit', '3');
  url.searchParams.set('pool_timeout', '10');
  url.searchParams.set('idle_timeout', '30');
  url.searchParams.set('connect_timeout', '10');

  const checkpointer = PostgresSaver.fromConnString(url.toString());
  await checkpointer.setup();

  return checkpointer;
}

/**
 * Create and initialize PostgreSQL checkpointer with fallback to memory
 */
export async function createCheckpointer(): Promise<PostgresSaver | MemorySaver> {
  // If we have a working postgres instance, return it
  if (checkpointerInstance) {
    return checkpointerInstance;
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
    const checkpointer = await createPostgresCheckpointer();
    checkpointerInstance = checkpointer;
    console.log('[Checkpointer] ✓ PostgreSQL checkpointer initialized');
    return checkpointer;
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
export function getCheckpointer(): PostgresSaver | MemorySaver {
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
