import { AgentStateType, TaskList, RouteType } from "../types/state.js";
import { sharedPublisher } from "../pubsub/shared.js";

/**
 * Task Executor Node - Orchestrates Multi-Step Workflows
 *
 * This node manages the execution of task lists:
 * 1. Picks the next pending task from the task list
 * 2. Marks it as in_progress
 * 3. Sets routing flags based on task route
 * 4. Passes task instruction as the message
 *
 * If all tasks are complete, routes to response_synthesizer.
 */
export async function taskExecutorNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const taskList = state.taskList;

  console.log('\n[TaskExecutor] ====== Task Executor Node ======');

  // If no task list, this shouldn't happen but handle gracefully
  if (!taskList) {
    console.log('[TaskExecutor] No task list found - unexpected state');
    return {};
  }

  console.log(`[TaskExecutor] Original query: "${taskList.originalQuery}"`);
  console.log(`[TaskExecutor] Total tasks: ${taskList.tasks.length}`);
  console.log('[TaskExecutor] Task statuses:', taskList.tasks.map(t => `${t.id.substring(0, 8)}:${t.status}`).join(', '));

  // Find next pending task
  const nextTask = taskList.tasks.find(t => t.status === 'pending');

  if (!nextTask) {
    // All tasks complete - signal to route to response_synthesizer
    console.log('[TaskExecutor] ✓ All tasks completed - routing to response_synthesizer');
    return {
      metadata: {
        ...state.metadata,
        allTasksComplete: true,
        // Clear all routing flags
        shouldSearchProperties: false,
        shouldFilterProperties: false,
        shouldUsePropertyOperations: false,
        shouldSearchPerplexity: false,
        shouldUseCollections: false,
        shouldUseShowings: false,
        shouldUseCommissions: false,
      },
    };
  }

  // Calculate task progress
  const completedCount = taskList.tasks.filter(t => t.status === 'completed').length;
  const totalCount = taskList.tasks.length;
  const taskNumber = completedCount + 1;

  console.log(`[TaskExecutor] Executing task ${taskNumber}/${totalCount}: ${nextTask.route}`);
  console.log(`[TaskExecutor] Task instruction: "${nextTask.task}"`);

  // Emit progress update
  const progressEmoji = getProgressEmoji(nextTask.route);
  await sharedPublisher.publishProgressUpdate({
    sessionId: state.metadata?.sessionId || '',
    userId: state.metadata?.userId,
    correlationId: state.metadata?.correlationId,
    status: `${progressEmoji} Step ${taskNumber}/${totalCount}: ${getProgressDescription(nextTask.route)}`,
  });

  // Mark task as in_progress
  const updatedTasks = taskList.tasks.map(t =>
    t.id === nextTask.id ? { ...t, status: 'in_progress' as const } : t
  );

  // Build routing flags based on task route
  const routingFlags = buildRoutingFlags(nextTask.route);

  console.log(`[TaskExecutor] Routing to: ${nextTask.route}`);
  console.log(`[TaskExecutor] Routing flags:`, JSON.stringify(routingFlags, null, 2));

  return {
    // Override message with task instruction for the route node
    message: nextTask.task,
    taskList: {
      ...taskList,
      tasks: updatedTasks,
      currentTaskIndex: taskList.tasks.indexOf(nextTask),
    },
    metadata: {
      ...state.metadata,
      ...routingFlags,
      currentTaskId: nextTask.id,
      taskNumber,
      totalTasks: totalCount,
    },
  };
}

/**
 * Build routing flags based on task route type
 */
function buildRoutingFlags(route: RouteType): Record<string, boolean> {
  // All flags start false
  const flags: Record<string, boolean> = {
    shouldSearchProperties: false,
    shouldFilterProperties: false,
    shouldUsePropertyOperations: false,
    shouldUseImageSimilarity: false,
    shouldSearchPerplexity: false,
    shouldUseCollections: false,
    shouldUseShowings: false,
    shouldUseCommissions: false,
  };

  // Set the appropriate flag
  switch (route) {
    case 'PROPERTY_SEARCH':
      flags.shouldSearchProperties = true;
      break;
    case 'PROPERTY_OPERATIONS':
      flags.shouldUsePropertyOperations = true;
      break;
    case 'PROPERTY_FILTER':
      flags.shouldFilterProperties = true;
      break;
    case 'IMAGE_SIMILARITY_SEARCH':
      flags.shouldUseImageSimilarity = true;
      break;
    case 'PERPLEXITY_SEARCH':
      flags.shouldSearchPerplexity = true;
      break;
    case 'COLLECTIONS':
      flags.shouldUseCollections = true;
      break;
    case 'SHOWINGS':
      flags.shouldUseShowings = true;
      break;
    case 'COMMISSIONS':
      flags.shouldUseCommissions = true;
      break;
    case 'DIRECT_RESPONSE':
      // No routing flag needed - handled specially
      break;
  }

  return flags;
}

/**
 * Get emoji for progress message based on route type
 */
function getProgressEmoji(route: RouteType): string {
  switch (route) {
    case 'PROPERTY_SEARCH':
      return '🔍';
    case 'PROPERTY_OPERATIONS':
      return '📋';
    case 'PROPERTY_FILTER':
      return '🔧';
    case 'IMAGE_SIMILARITY_SEARCH':
      return '🖼️';
    case 'PERPLEXITY_SEARCH':
      return '🌐';
    case 'COLLECTIONS':
      return '📁';
    case 'SHOWINGS':
      return '📅';
    case 'COMMISSIONS':
      return '💰';
    default:
      return '⚙️';
  }
}

/**
 * Get human-readable progress description based on route type
 */
function getProgressDescription(route: RouteType): string {
  switch (route) {
    case 'PROPERTY_SEARCH':
      return 'Searching for properties...';
    case 'PROPERTY_OPERATIONS':
      return 'Processing property data...';
    case 'PROPERTY_FILTER':
      return 'Filtering results...';
    case 'IMAGE_SIMILARITY_SEARCH':
      return 'Finding similar rooms...';
    case 'PERPLEXITY_SEARCH':
      return 'Researching information...';
    case 'COLLECTIONS':
      return 'Managing collection...';
    case 'SHOWINGS':
      return 'Processing showing request...';
    case 'COMMISSIONS':
      return 'Processing commission request...';
    default:
      return 'Processing...';
  }
}
