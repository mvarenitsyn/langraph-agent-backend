import { AgentStateType } from "../types/state.js";
import { sharedPublisher } from "../pubsub/shared.js";

/**
 * Task Complete Node - Marks Tasks Complete and Manages Flow
 *
 * This node runs after each route node completes:
 * 1. Marks the current task as completed with its results
 * 2. Checks if more tasks remain
 * 3. Publishes progress updates
 * 4. Signals whether to loop back to task_executor or proceed to response_synthesizer
 */
export async function taskCompleteNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const taskList = state.taskList;
  const currentTaskId = state.metadata?.currentTaskId;

  console.log('\n[TaskComplete] ====== Task Complete Node ======');

  // If not in task list mode, just pass through
  if (!taskList) {
    console.log('[TaskComplete] No task list - passing through');
    return {};
  }

  if (!currentTaskId) {
    console.log('[TaskComplete] No currentTaskId - unexpected state');
    return {};
  }

  // Find the current task
  const currentTask = taskList.tasks.find(t => t.id === currentTaskId);
  if (!currentTask) {
    console.log(`[TaskComplete] Task ${currentTaskId} not found - unexpected state`);
    return {};
  }

  console.log(`[TaskComplete] Completing task: ${currentTask.route} - "${currentTask.task}"`);

  // Check for errors
  const hasError = !!state.error;
  if (hasError) {
    console.log(`[TaskComplete] ❌ Task failed with error: ${state.error}`);

    // Mark task as failed
    const failedTasks = taskList.tasks.map(t =>
      t.id === currentTaskId
        ? { ...t, status: 'failed' as const, error: state.error || 'Unknown error' }
        : t
    );

    // Emit failure progress
    const taskNumber = state.metadata?.taskNumber || 1;
    const totalTasks = state.metadata?.totalTasks || 1;
    await sharedPublisher.publishProgressUpdate({
      sessionId: state.metadata?.sessionId || '',
      userId: state.metadata?.userId,
      correlationId: state.metadata?.correlationId,
      status: `❌ Step ${taskNumber}/${totalTasks} failed: ${state.error}`,
    });

    // Abort entire task list on failure
    return {
      taskList: {
        ...taskList,
        tasks: failedTasks,
      },
      metadata: {
        ...state.metadata,
        hasMoreTasks: false,
        taskFailed: true,
        currentTaskId: undefined,
      },
      // Keep the error, let response_synthesizer handle it
    };
  }

  // Mark current task as completed with results
  let updatedTasks = taskList.tasks.map(t =>
    t.id === currentTaskId
      ? {
          ...t,
          status: 'completed' as const,
          result: {
            searchId: state.metadata?.searchId,
            toolResults: state.toolResults,
            response: state.finalResponse || undefined,
            totalCount: state.metadata?.totalCount,
          },
        }
      : t
  );

  // 🏢 Multi-unit building detection: Skip PROPERTY_OPERATIONS if search found multiple properties
  // This handles cases like "19390 Collins Ave" which is a condo building with 26+ units
  if (currentTask.route === 'PROPERTY_SEARCH') {
    const resultCount = state.toolResults?.searchResults?.length || 0;

    if (resultCount > 1) {
      // Find next pending task
      const nextPendingTask = updatedTasks.find(t => t.status === 'pending');

      if (nextPendingTask?.route === 'PROPERTY_OPERATIONS') {
        // Check if it's requesting details for an address (not a specific listing key)
        const taskInstruction = nextPendingTask.task.toLowerCase();
        const isAddressDetailsRequest =
          taskInstruction.includes('details') ||
          taskInstruction.includes('property') ||
          taskInstruction.includes('listing');

        if (isAddressDetailsRequest) {
          console.log(`[TaskComplete] 🏢 Multi-unit building detected (${resultCount} properties)`);
          console.log(`[TaskComplete] ⏭️  Skipping PROPERTY_OPERATIONS - showing search results instead`);

          // Mark the task as skipped
          updatedTasks = updatedTasks.map(t =>
            t.id === nextPendingTask.id
              ? {
                  ...t,
                  status: 'skipped' as const,
                  skipReason: `Multiple properties (${resultCount}) found at address - showing search results instead`,
                }
              : t
          );
        }
      }
    }
  }

  // Check if more tasks remain (pending only, not skipped)
  const hasMoreTasks = updatedTasks.some(t => t.status === 'pending');

  console.log(`[TaskComplete] ✓ Task completed`);
  console.log(`[TaskComplete] Has more tasks: ${hasMoreTasks}`);
  console.log(`[TaskComplete] Task statuses:`, updatedTasks.map(t => `${t.id.substring(0, 8)}:${t.status}`).join(', '));

  // Emit progress update
  const completedCount = updatedTasks.filter(t => t.status === 'completed').length;
  const totalCount = updatedTasks.length;

  if (hasMoreTasks) {
    // Intermediate completion - publish step complete
    const stepEmoji = getStepCompleteEmoji(currentTask.route);
    const stepSummary = getStepSummary(currentTask, state);

    await sharedPublisher.publishProgressUpdate({
      sessionId: state.metadata?.sessionId || '',
      userId: state.metadata?.userId,
      correlationId: state.metadata?.correlationId,
      status: `${stepEmoji} Step ${completedCount}/${totalCount} complete: ${stepSummary}`,
    });
  } else {
    // All tasks complete
    await sharedPublisher.publishProgressUpdate({
      sessionId: state.metadata?.sessionId || '',
      userId: state.metadata?.userId,
      correlationId: state.metadata?.correlationId,
      status: `✅ All ${totalCount} steps complete, generating response...`,
    });
  }

  return {
    taskList: {
      ...taskList,
      tasks: updatedTasks,
    },
    metadata: {
      ...state.metadata,
      hasMoreTasks,
      // Clear current task ID so task_executor picks up next one
      currentTaskId: undefined,
      // Clear routing flags so routing works correctly
      shouldSearchProperties: false,
      shouldFilterProperties: false,
      shouldUsePropertyOperations: false,
      shouldSearchPerplexity: false,
      shouldUseCollections: false,
      shouldUseShowings: false,
      shouldUseCommissions: false,
    },
    // Clear finalResponse if more tasks remain (let response_synthesizer generate final)
    finalResponse: hasMoreTasks ? null : state.finalResponse,
  };
}

/**
 * Get emoji for completed step based on route type
 */
function getStepCompleteEmoji(route: string): string {
  switch (route) {
    case 'PROPERTY_SEARCH':
      return '✓🔍';
    case 'PROPERTY_OPERATIONS':
      return '✓📋';
    case 'PROPERTY_FILTER':
      return '✓🔧';
    case 'PERPLEXITY_SEARCH':
      return '✓🌐';
    case 'COLLECTIONS':
      return '✓📁';
    case 'SHOWINGS':
      return '✓📅';
    case 'COMMISSIONS':
      return '✓💰';
    default:
      return '✓';
  }
}

/**
 * Get a brief summary of what this step accomplished
 */
function getStepSummary(task: { route: string; task: string }, state: AgentStateType): string {
  switch (task.route) {
    case 'PROPERTY_SEARCH':
      const count = state.metadata?.totalCount;
      return count ? `Found ${count} properties` : 'Search complete';
    case 'PROPERTY_OPERATIONS':
      return 'Property details retrieved';
    case 'PROPERTY_FILTER':
      return 'Filtered results';
    case 'PERPLEXITY_SEARCH':
      return 'Research complete';
    case 'COLLECTIONS':
      return 'Collection updated';
    case 'SHOWINGS':
      return 'Showing processed';
    case 'COMMISSIONS':
      return 'Commission request processed';
    default:
      return 'Complete';
  }
}
