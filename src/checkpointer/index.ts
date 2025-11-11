import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { config } from "../config/index.js";

/**
 * PostgreSQL Checkpointer
 *
 * Provides persistent checkpoint storage for LangGraph agents.
 * Enables conversation memory, state persistence, and time-travel debugging.
 */

let checkpointerInstance: PostgresSaver | null = null;

/**
 * Create and initialize PostgreSQL checkpointer
 */
export async function createCheckpointer(): Promise<PostgresSaver> {
  if (checkpointerInstance) {
    return checkpointerInstance;
  }

  console.log('[Checkpointer] Initializing PostgreSQL checkpointer...');

  try {
    // Create checkpointer from connection string
    const checkpointer = PostgresSaver.fromConnString(config.database.url);

    // Setup database tables if not exists
    await checkpointer.setup();

    checkpointerInstance = checkpointer;
    console.log('[Checkpointer] ✓ PostgreSQL checkpointer initialized');

    return checkpointer;
  } catch (error) {
    console.error('[Checkpointer] ✗ Failed to initialize checkpointer:', error);
    throw new Error(`Checkpointer initialization failed: ${error}`);
  }
}

/**
 * Get the existing checkpointer instance
 */
export function getCheckpointer(): PostgresSaver {
  if (!checkpointerInstance) {
    throw new Error('Checkpointer not initialized. Call createCheckpointer() first.');
  }
  return checkpointerInstance;
}

/**
 * Close the checkpointer connection
 */
export async function closeCheckpointer(): Promise<void> {
  if (checkpointerInstance) {
    // PostgresSaver doesn't have an explicit close method,
    // but we can clear the instance reference
    checkpointerInstance = null;
    console.log('[Checkpointer] ✓ Checkpointer connection closed');
  }
}
