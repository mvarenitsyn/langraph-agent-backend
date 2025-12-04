import { AIMessage, HumanMessage, ToolMessage, SystemMessage } from "@langchain/core/messages";
import { AgentStateType } from "../types/state.js";
import { globalToolsRegistry } from "../tools/registry.js";
import { createToolCallingModel, createResponseModel } from "../models/openai.js";
import { sharedPublisher } from "../pubsub/shared.js";
import { getPlatformContext, shouldPublishUIEvents } from "../utils/platformContext.js";
import { buildFormattingInstructions, adaptMarkdown, truncateResponse } from "../utils/formatters.js";

/**
 * Showings Node - Mini Agent with Tool Loop
 *
 * This node is a specialized mini-agent that manages property showings:
 * 1. showing_create - Create showing request
 * 2. showing_list - List user's showings
 * 3. showing_get - Get showing details
 * 4. showing_reschedule - Reschedule showing
 * 5. showing_cancel - Cancel showing
 *
 * Flow:
 * - Uses LLM with showing tools bound
 * - Can call tools in a loop for complex operations
 * - Generates final response after tools complete
 */
export async function showingsNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.log('\n[Showings] Starting showings agent...');

  // Emit progress: Processing showing operation
  await sharedPublisher.publishProgressUpdate({
    sessionId: state.metadata?.sessionId || '',
    userId: state.metadata?.userId,
    correlationId: state.metadata?.correlationId,
    status: 'Processing showing operation...',
  });

  const userContext = state.userContext || { isAuthenticated: false };
  const userName = userContext.fullName || 'there';
  const firstName = userName.split(' ')[0];
  const isAuthenticated = userContext.isAuthenticated || false;

  // Resolve platform context
  const platformContext = getPlatformContext(state);
  console.log(`[Showings] Platform: ${platformContext.platform} (supportsRichUI: ${platformContext.capabilities.supportsRichUI})`);

  if (isAuthenticated && userContext.userId) {
    console.log(`[Showings] User: ${userName}`);
    console.log(`  - Showings: ${userContext.showingsCount || 0}`);
  } else {
    console.warn('[Showings] ⚠️ User not authenticated - showings require authentication');
  }

  try {
    // Get showing tools
    const showingCreateTool = globalToolsRegistry.getTool('showing_create');
    const showingListTool = globalToolsRegistry.getTool('showing_list');
    const showingGetTool = globalToolsRegistry.getTool('showing_get');
    const showingRescheduleTool = globalToolsRegistry.getTool('showing_reschedule');
    const showingCancelTool = globalToolsRegistry.getTool('showing_cancel');

    if (!showingCreateTool || !showingListTool || !showingGetTool || !showingRescheduleTool || !showingCancelTool) {
      const missing = [];
      if (!showingCreateTool) missing.push('showing_create');
      if (!showingListTool) missing.push('showing_list');
      if (!showingGetTool) missing.push('showing_get');
      if (!showingRescheduleTool) missing.push('showing_reschedule');
      if (!showingCancelTool) missing.push('showing_cancel');
      throw new Error(`Required showing tools not found: ${missing.join(', ')}`);
    }

    const tools = [
      showingCreateTool,
      showingListTool,
      showingGetTool,
      showingRescheduleTool,
      showingCancelTool,
    ];

    console.log(`[Showings] ✓ Registered ${tools.length} tools: ${tools.map(t => t.name).join(', ')}`);

    // Create model with tools bound
    const toolModel = createToolCallingModel();
    const modelWithTools = toolModel.bindTools(tools);

    console.log('[Showings] ✓ Tools bound to model successfully');

    // Build rich system prompt with user context
    let systemPrompt = '';

    if (isAuthenticated) {
      systemPrompt = `You are RealVista, a showing specialist helping ${userName} schedule and manage property showings in South Florida.`;

      // Add user's showings context
      if (userContext.showingsCount && userContext.showingsCount > 0) {
        systemPrompt += `\n\n**${firstName}'s Showings:** ${userContext.showingsCount} scheduled showings`;
      }
    } else {
      systemPrompt = `You are RealVista, a showing specialist for South Florida real estate.

**⚠️ AUTHENTICATION REQUIRED**
Showings require user authentication. All showing tools will fail unless the user is logged in.`;
    }

    const instructions = `
Your job: Use the available tools to help the user schedule and manage property showings.

**Available Tools:**

1. **showing_create** - Create a showing request for a property
   - Parameters: listingKey (required), preferredDate (required), preferredTimeSlot (optional), notes (optional)
   - Use when: User wants to schedule a property showing or tour

2. **showing_list** - List user's showing requests
   - Parameters: status (optional: pending/confirmed/cancelled/completed), limit (optional)
   - Use when: User asks to see their showings

3. **showing_get** - Get details for a specific showing
   - Parameters: showingId (required)
   - Use when: User wants to see showing details

4. **showing_reschedule** - Request to reschedule a showing
   - Parameters: showingId (required), newDate (required), newTimeSlot (optional), reason (optional)
   - Use when: User wants to change showing date/time

5. **showing_cancel** - Cancel a showing request
   - Parameters: showingId (required), reason (optional)
   - Use when: User wants to cancel a showing

**Tool Execution Strategy:**

You can call tools in ANY ORDER based on the user's query. Common patterns:

**Single tool**:
- "schedule a showing for this property" → showing_create
- "show my showings" → showing_list

**Sequential chain**:
- "reschedule my showing to tomorrow" → showing_list (to find showing) → showing_reschedule
- "cancel tomorrow's showing" → showing_list (to find showing) → showing_cancel

**Multiple iterations**:
- "show my showings and cancel the first one" →
  showing_list → showing_cancel

**Critical Rules:**
1. **ALWAYS USE TOOLS** - Don't just respond with text. Execute the appropriate tools.
2. For reschedule/cancel operations, you need the showingId - use showing_list first if needed
3. All tools require authentication (userId) - they will fail if user is not logged in
4. For creating showings, you need a listingKey from property search results
5. Parse relative dates (tomorrow, next week) in tool implementations
6. Call tools as many times as needed to fully answer the user's query
7. Provide clear feedback about what was done
`;

    // Add platform-specific formatting instructions
    const platformFormattingInstructions = buildFormattingInstructions(platformContext);
    systemPrompt += '\n' + platformFormattingInstructions;

    // 🚨 FIX: Start fresh without conversation history to avoid tool_calls/tool messages mismatch
    // The mini-agent only needs current message + user context to execute tools
    // Including checkpoint history can cause OpenAI API errors if it contains orphaned tool messages
    const latestUserMessage = new HumanMessage({ content: state.message });

    let currentMessages: (SystemMessage | HumanMessage | AIMessage | ToolMessage)[] = [
      new SystemMessage({ content: `${systemPrompt}\n${instructions}` }),
      latestUserMessage,
    ];

    // Track where the current turn's tool loop starts
    const toolLoopStartIndex = 2; // System + User messages

    const toolResults: Record<string, any> = {};
    const toolMessages: ToolMessage[] = [];
    let loopCount = 0;
    const maxLoops = 3;

    // Tool execution loop
    while (loopCount < maxLoops) {
      console.log(`[Showings] Tool loop iteration ${loopCount + 1}/${maxLoops}`);

      const response = await modelWithTools.invoke(currentMessages);

      // Check if tools were called
      if (response.tool_calls && response.tool_calls.length > 0) {
        console.log(`[Showings] LLM requested ${response.tool_calls.length} tool(s): ${response.tool_calls.map(tc => tc.name).join(', ')}`);

        // Add AI message with tool calls to history
        currentMessages.push(response);

        // Execute each tool call
        for (const toolCall of response.tool_calls) {
          const tool = tools.find(t => t.name === toolCall.name);
          if (!tool) {
            console.error(`[Showings] Tool ${toolCall.name} not found`);
            continue;
          }

          console.log(`[Showings] Executing ${toolCall.name} with args:`, toolCall.args);

          // Pass metadata through config for userId extraction and UI event publishing
          const configWithMetadata = {
            metadata: {
              userId: state.metadata?.userId,
              sessionId: state.metadata?.sessionId,
              correlationId: state.metadata?.correlationId,
            },
          } as any;

          const result = await tool.invoke(toolCall.args, configWithMetadata);
          const resultStr = typeof result === 'string' ? result : JSON.stringify(result);

          // Store result
          toolResults[toolCall.name] = resultStr;

          // Create tool message
          const toolMessage = new ToolMessage({
            content: resultStr,
            tool_call_id: toolCall.id || `${toolCall.name}_${Date.now()}`,
            name: toolCall.name,
          });

          toolMessages.push(toolMessage);
          currentMessages.push(toolMessage);
        }

        loopCount++;
      } else {
        // No more tool calls - exit loop
        console.log('[Showings] No more tool calls - proceeding to response generation');
        break;
      }
    }

    if (loopCount >= maxLoops) {
      console.warn('[Showings] Max tool loop iterations reached');
    }

    console.log('[Showings] ✓ Tool execution completed, generating final response...');

    // Generate final response using a separate model
    const responseModel = createResponseModel();

    const responseInstructions = `
**Your job:** Create a concise, helpful response based on the showing operation results.

**Response Style:**
${isAuthenticated
        ? `- Address the user by their first name: ${firstName}
- Maintain a personal, conversational tone`
        : `- Use a friendly, professional tone`}
- Be concise and direct
- Use bullet points for key information
- Summarize what was done
- Include showing status and next steps
- End with 1-2 clear next step suggestions

${platformFormattingInstructions}

Generate a focused response based on the tool results below.
`;

    // Clean message history for response generation
    const toolLoopConversation = currentMessages.slice(toolLoopStartIndex);

    const responseMessages = [
      new SystemMessage({ content: `${systemPrompt}\n${responseInstructions}` }),
      latestUserMessage,
      ...toolLoopConversation,
    ];

    const finalResponseMsg = await responseModel.invoke(responseMessages);
    let finalResponse = finalResponseMsg.content as string;

    console.log('[Showings] ✓ Response generated');

    // Adapt response for non-web platforms
    if (platformContext.platform !== 'web') {
      finalResponse = adaptMarkdown(finalResponse, platformContext);
      finalResponse = truncateResponse(finalResponse, platformContext);
      console.log(`[Showings] Response adapted for ${platformContext.platform} (${finalResponse.length} chars)`);
    }

    return {
      finalResponse,
      messages: [...toolMessages, new AIMessage({ content: finalResponse })],
      toolResults,
      platformContext,
    };
  } catch (error) {
    console.error('[Showings] Error:', error);
    return {
      error: error instanceof Error ? error.message : 'Showing operation failed',
      finalResponse: 'I apologize, but I encountered an error with the showing operation. Please try again.',
    };
  }
}
