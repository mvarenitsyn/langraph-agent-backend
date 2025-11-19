/**
 * DEPRECATED: Retry Node (Removed during simplification)
 *
 * This file is kept as a stub to prevent import errors.
 * The retry node was removed as part of the ground-up rebuild to fix duplicate response bug.
 *
 * Original Purpose: Implemented retry logic based on reflection recommendations
 * Removed: January 2025 (ground-up rebuild)
 */

import { AgentStateType } from "../types/state.js";

export async function retryNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.warn('[Retry] DEPRECATED: This node should not be called - removed during simplification');
  return { error: 'Retry node has been removed' };
}

export function shouldRetryRoute(state: AgentStateType): string {
  console.warn('[Retry] DEPRECATED: This routing function should not be called - removed during simplification');
  return 'generate_response';
}
