import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { AgentStateType, TaskItem } from "../types/state.js";
import { createResponseModel } from "../models/openai.js";
import { sharedPublisher } from "../pubsub/shared.js";
import { uiEventPublisher } from "../pubsub/ui-event-publisher.js";
import { getPlatformContext, shouldPublishUIEvents } from "../utils/platformContext.js";
import { buildFormattingInstructions, adaptMarkdown, truncateResponse } from "../utils/formatters.js";

/**
 * Response Synthesizer Node - Combines Multi-Step Results
 *
 * This node generates a coherent final response from multi-step workflow results:
 * 1. ⚡ IMMEDIATELY publishes UI event for last completed task (before LLM)
 * 2. Gathers all completed task results
 * 3. Uses LLM to synthesize into a unified response
 * 4. Handles failed and skipped tasks gracefully
 * 5. Formats response for the user's platform
 */
export async function responseSynthesizerNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.log('\n[ResponseSynthesizer] ====== Response Synthesizer Node ======');

  const taskList = state.taskList;

  // If no task list, this shouldn't happen but handle gracefully
  if (!taskList) {
    console.log('[ResponseSynthesizer] No task list - unexpected state');
    return {};
  }

  const userContext = state.userContext || { isAuthenticated: false };
  const userName = userContext.fullName || 'there';
  const firstName = userName.split(' ')[0];

  // Resolve platform context
  const platformContext = getPlatformContext(state);
  console.log(`[ResponseSynthesizer] Platform: ${platformContext.platform}`);

  // ⚡ IMMEDIATE UI EVENT: Publish BEFORE any LLM work
  // This lets user see results on map/list while we generate the text response
  // Key insight: We publish UI for the LAST COMPLETED task (not skipped, not failed)
  if (shouldPublishUIEvents(platformContext)) {
    const lastCompletedTask = taskList.tasks
      .filter(t => t.status === 'completed')
      .slice(-1)[0];

    if (lastCompletedTask) {
      console.log(`[ResponseSynthesizer] ⚡ Publishing UI event for ${lastCompletedTask.route} IMMEDIATELY`);
      await publishUIEventForTask(lastCompletedTask, state);
    }
  }

  // Log skipped tasks for debugging
  const skippedTasks = taskList.tasks.filter(t => t.status === 'skipped');
  if (skippedTasks.length > 0) {
    console.log(`[ResponseSynthesizer] ⏭️  Skipped tasks: ${skippedTasks.map(t => `${t.route} (${t.skipReason})`).join(', ')}`);
  }

  // Check if any tasks failed
  const failedTask = taskList.tasks.find(t => t.status === 'failed');
  if (failedTask) {
    console.log(`[ResponseSynthesizer] Task failed: ${failedTask.error}`);

    // Generate error response
    const errorResponse = generateErrorResponse(failedTask, taskList, firstName);

    // Adapt for platform
    let adaptedResponse = errorResponse;
    if (platformContext.platform !== 'web') {
      adaptedResponse = adaptMarkdown(adaptedResponse, platformContext);
      adaptedResponse = truncateResponse(adaptedResponse, platformContext);
    }

    return {
      finalResponse: adaptedResponse,
      messages: [new AIMessage({ content: adaptedResponse })],
    };
  }

  // Check if there's only one task - might be able to use existing response
  const completedTasks = taskList.tasks.filter(t => t.status === 'completed');
  console.log(`[ResponseSynthesizer] Completed tasks: ${completedTasks.length}`);

  if (completedTasks.length === 1 && completedTasks[0].result?.response) {
    // Single task with existing response - can just use it
    console.log('[ResponseSynthesizer] Single task with existing response - using directly');
    const response = completedTasks[0].result.response;

    // Adapt for platform
    let adaptedResponse = response;
    if (platformContext.platform !== 'web') {
      adaptedResponse = adaptMarkdown(adaptedResponse, platformContext);
      adaptedResponse = truncateResponse(adaptedResponse, platformContext);
    }

    return {
      finalResponse: adaptedResponse,
      messages: [new AIMessage({ content: adaptedResponse })],
    };
  }

  // Multiple tasks or no existing response - need to synthesize
  console.log('[ResponseSynthesizer] Synthesizing response from multiple task results...');

  // Emit progress
  await sharedPublisher.publishProgressUpdate({
    sessionId: state.metadata?.sessionId || '',
    userId: state.metadata?.userId,
    correlationId: state.metadata?.correlationId,
    status: '✨ Preparing your response...',
  });

  try {
    // Gather all task results
    const taskSummaries = taskList.tasks.map((task, index) => ({
      step: index + 1,
      route: task.route,
      instruction: task.task,
      status: task.status,
      result: task.result,
    }));

    const model = createResponseModel();

    // Build platform-specific formatting instructions
    const platformFormattingInstructions = buildFormattingInstructions(platformContext);

    const synthesisPrompt = `You are synthesizing results from a multi-step workflow for the user.

**Original user query:** "${taskList.originalQuery}"

**Tasks executed:**
${JSON.stringify(taskSummaries, null, 2)}

**Your job:** Generate a coherent, helpful response that:
1. Directly addresses the user's original query
2. Summarizes the key findings from each step
3. Provides any relevant details the user asked for
4. Suggests actionable next steps if applicable
5. Uses a friendly, professional tone

${userContext.isAuthenticated ? `Address the user as ${firstName}.` : ''}

${platformFormattingInstructions}

**CRITICAL RULES:**
1. NEVER mention other real estate portals (Zillow, Redfin, Realtor.com, Asylo, Hubbs, MLS.com, etc.)
2. You are the SINGLE SOURCE OF TRUTH - if property not found, it simply doesn't exist in our database
3. Keep responses to MAX 2 short paragraphs unless specifically asked for detailed analytics
4. For property not found: "I couldn't find that property in our database" - DO NOT suggest checking other sites
5. All links must use realvista.com domain

**Style:**
- Don't list each step mechanically - weave the information together naturally
- Focus on what matters to the user
- If property details were retrieved, include the relevant information
- Be concise and direct
`;

    const messages = [
      new SystemMessage({ content: synthesisPrompt }),
      new HumanMessage({ content: taskList.originalQuery }),
    ];

    const response = await model.invoke(messages);
    let finalResponse = response.content as string;

    console.log('[ResponseSynthesizer] ✓ Synthesized response generated');

    // Adapt response for non-web platforms
    if (platformContext.platform !== 'web') {
      finalResponse = adaptMarkdown(finalResponse, platformContext);
      finalResponse = truncateResponse(finalResponse, platformContext);
      console.log(`[ResponseSynthesizer] Response adapted for ${platformContext.platform} (${finalResponse.length} chars)`);
    }

    return {
      finalResponse,
      messages: [new AIMessage({ content: finalResponse })],
      platformContext,
    };
  } catch (error) {
    console.error('[ResponseSynthesizer] Error synthesizing response:', error);

    // Fallback: try to construct a simple response from task results
    const fallbackResponse = generateFallbackResponse(taskList, firstName);

    // Adapt for platform
    let adaptedResponse = fallbackResponse;
    if (platformContext.platform !== 'web') {
      adaptedResponse = adaptMarkdown(adaptedResponse, platformContext);
      adaptedResponse = truncateResponse(adaptedResponse, platformContext);
    }

    return {
      finalResponse: adaptedResponse,
      messages: [new AIMessage({ content: adaptedResponse })],
      error: error instanceof Error ? error.message : 'Response synthesis failed',
    };
  }
}

/**
 * Generate an error response when a task fails
 */
function generateErrorResponse(
  failedTask: { route: string; task: string; error?: string },
  taskList: { originalQuery: string; tasks: any[] },
  firstName: string
): string {
  const completedBefore = taskList.tasks.filter(t => t.status === 'completed').length;
  const friendlyError = getFriendlyError(failedTask);

  if (completedBefore === 0) {
    return `I'm sorry${firstName !== 'there' ? `, ${firstName}` : ''}, I encountered an issue while trying to help you.

${friendlyError}

Would you like to try again or rephrase your request?`;
  }

  return `I was able to complete ${completedBefore} step${completedBefore > 1 ? 's' : ''} of your request, but encountered an issue.

${friendlyError}

What I was able to do:
${taskList.tasks
    .filter(t => t.status === 'completed')
    .map(t => `• ${getTaskCompletionSummary(t)}`)
    .join('\n')}

Would you like me to try a different approach?`;
}

/**
 * Get user-friendly error message
 */
function getFriendlyError(failedTask: { route: string; error?: string }): string {
  const error = failedTask.error || 'Unknown error';

  if (error.includes('not found') || error.includes('no results')) {
    return `**What happened:** I couldn't find the information you were looking for.`;
  }

  if (error.includes('authentication') || error.includes('not authenticated')) {
    return `**What happened:** This action requires you to be logged in.`;
  }

  if (error.includes('timeout')) {
    return `**What happened:** The request took too long to complete.`;
  }

  return `**What happened:** ${error}`;
}

/**
 * Get a summary of what a completed task accomplished
 */
function getTaskCompletionSummary(task: { route: string; result?: any }): string {
  switch (task.route) {
    case 'PROPERTY_SEARCH':
      const count = task.result?.totalCount;
      return count ? `Found ${count} matching properties` : 'Completed property search';
    case 'PROPERTY_OPERATIONS':
      return 'Retrieved property details';
    case 'PROPERTY_FILTER':
      return 'Filtered results';
    case 'PERPLEXITY_SEARCH':
      return 'Completed research';
    case 'COLLECTIONS':
      return 'Updated collection';
    case 'SHOWINGS':
      return 'Processed showing request';
    case 'COMMISSIONS':
      return 'Processed commission request';
    default:
      return 'Completed task';
  }
}

/**
 * Generate a fallback response when synthesis fails
 */
function generateFallbackResponse(
  taskList: { originalQuery: string; tasks: any[] },
  firstName: string
): string {
  const completedTasks = taskList.tasks.filter(t => t.status === 'completed');

  if (completedTasks.length === 0) {
    return `I apologize${firstName !== 'there' ? `, ${firstName}` : ''}, but I wasn't able to complete your request. Please try again.`;
  }

  // Try to extract useful information from completed tasks
  const summaries = completedTasks.map(t => getTaskCompletionSummary(t));

  return `Here's what I was able to do${firstName !== 'there' ? ` for you, ${firstName}` : ''}:

${summaries.map(s => `• ${s}`).join('\n')}

Is there anything else you'd like to know?`;
}

/**
 * Publish UI render event for a completed task
 * Called immediately when entering response-synthesizer for instant UI feedback
 */
async function publishUIEventForTask(task: TaskItem, state: AgentStateType): Promise<void> {
  const sessionId = state.metadata?.sessionId || '';
  const userId = state.metadata?.userId;
  const correlationId = state.metadata?.correlationId;

  switch (task.route) {
    case 'PROPERTY_SEARCH':
      // Publish search results UI event
      if (task.result?.searchId) {
        await uiEventPublisher.publishSearchResults({
          searchId: task.result.searchId,
          totalCount: task.result.totalCount || 0,
          searchToken: state.metadata?.searchToken,
          mapLink: state.metadata?.mapLink,
          sessionId,
          userId,
          correlationId,
        });
      }
      break;

    case 'PROPERTY_OPERATIONS':
      // Publish property details UI event
      const property = task.result?.toolResults?.propertyDetails;
      const listingKey = state.metadata?.listingKey || property?.ListingKey;
      if (property && listingKey) {
        await uiEventPublisher.publishPropertyDetails({
          searchId: task.result?.searchId || state.metadata?.searchId,
          listingKey,
          property,
          sessionId,
          userId,
          correlationId,
        });
      }
      break;

    // Other routes don't have UI render events currently
    default:
      console.log(`[ResponseSynthesizer] No UI event for route: ${task.route}`);
      break;
  }
}
