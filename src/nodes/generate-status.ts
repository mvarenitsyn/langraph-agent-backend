/**
 * DEPRECATED: Generate Status Node (Removed during simplification)
 *
 * This file is kept as a stub to prevent import errors.
 * The generate_status node was removed as part of the ground-up rebuild to fix duplicate response bug.
 *
 * Original Purpose: Parallel status message generation while tools executed
 * Removed: January 2025 (ground-up rebuild)
 */

import { AgentStateType } from "../types/state.js";

export async function generateStatusNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.warn('[GenerateStatus] DEPRECATED: This node should not be called - removed during simplification');
  return { error: 'Generate status node has been removed' };
}
