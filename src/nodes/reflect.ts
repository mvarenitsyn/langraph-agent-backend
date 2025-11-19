/**
 * DEPRECATED: Reflect Node (Removed during simplification)
 *
 * This file is kept as a stub to prevent import errors.
 * The reflect node was removed as part of the ground-up rebuild to fix duplicate response bug.
 *
 * Original Purpose: Evaluated response quality and recommended RETRY/PROCEED
 * Removed: January 2025 (ground-up rebuild)
 */

import { AgentStateType } from "../types/state.js";

export async function reflectNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.warn('[Reflect] DEPRECATED: This node should not be called - removed during simplification');
  return { error: 'Reflect node has been removed' };
}
