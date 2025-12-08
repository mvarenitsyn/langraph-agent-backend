import { AIMessage, HumanMessage, ToolMessage, SystemMessage } from "@langchain/core/messages";
import { AgentStateType } from "../types/state.js";
import { globalToolsRegistry } from "../tools/registry.js";
import { createToolCallingModel, createResponseModel } from "../models/openai.js";
import { sharedPublisher } from "../pubsub/shared.js";
import { getPlatformContext, shouldPublishUIEvents } from "../utils/platformContext.js";
import { buildFormattingInstructions, adaptMarkdown, truncateResponse } from "../utils/formatters.js";

/**
 * Commissions Node - Mini Agent with Tool Loop
 *
 * This node is a specialized mini-agent that manages commission requests:
 * 1. commission_request - Create commission request
 * 2. commission_list - List user's commission requests
 * 3. commission_unread_count - Get unread commission responses count
 *
 * Flow:
 * - Uses LLM with commission tools bound
 * - Can call tools in a loop for complex operations
 * - Generates final response after tools complete
 */
export async function commissionsNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.log('\n[Commissions] Starting commissions agent...');

  // Emit progress: Processing commission operation
  await sharedPublisher.publishProgressUpdate({
    sessionId: state.metadata?.sessionId || '',
    userId: state.metadata?.userId,
    correlationId: state.metadata?.correlationId,
    status: 'Processing commission operation...',
  });

  const userContext = state.userContext || { isAuthenticated: false };
  const userName = userContext.fullName || 'there';
  const firstName = userName.split(' ')[0];
  const isAuthenticated = userContext.isAuthenticated || false;

  // Resolve platform context
  const platformContext = getPlatformContext(state);
  console.log(`[Commissions] Platform: ${platformContext.platform} (supportsRichUI: ${platformContext.capabilities.supportsRichUI})`);

  if (isAuthenticated && userContext.userId) {
    console.log(`[Commissions] User: ${userName}`);
  } else {
    console.warn('[Commissions] ⚠️ User not authenticated - commissions require authentication');
  }

  // Get searchId from state metadata
  const searchId = state.metadata?.searchId;
  console.log(`[Commissions] SearchId from state: ${searchId || 'NONE'}`);

  try {
    // Get commission tools
    const commissionRequestTool = globalToolsRegistry.getTool('commission_request');
    const commissionListTool = globalToolsRegistry.getTool('commission_list');
    const commissionUnreadCountTool = globalToolsRegistry.getTool('commission_unread_count');
    // Also get property_get_details to get listing agent email before commission request
    const propertyGetDetailsTool = globalToolsRegistry.getTool('property_get_details');

    if (!commissionRequestTool || !commissionListTool || !commissionUnreadCountTool) {
      const missing = [];
      if (!commissionRequestTool) missing.push('commission_request');
      if (!commissionListTool) missing.push('commission_list');
      if (!commissionUnreadCountTool) missing.push('commission_unread_count');
      throw new Error(`Required commission tools not found: ${missing.join(', ')}`);
    }

    const tools = [
      commissionRequestTool,
      commissionListTool,
      commissionUnreadCountTool,
    ];

    // Add property_get_details if available (needed to get listing agent email)
    if (propertyGetDetailsTool) {
      tools.push(propertyGetDetailsTool);
      console.log('[Commissions] ✓ property_get_details tool added for agent email lookup');
    } else {
      console.warn('[Commissions] ⚠️ property_get_details not available - commission requests may fail without agent email');
    }

    console.log(`[Commissions] ✓ Registered ${tools.length} tools: ${tools.map(t => t.name).join(', ')}`);

    // Create model with tools bound
    const toolModel = createToolCallingModel();
    const modelWithTools = toolModel.bindTools(tools);

    console.log('[Commissions] ✓ Tools bound to model successfully');

    // Build rich system prompt with user context
    let systemPrompt = '';

    if (isAuthenticated) {
      systemPrompt = `You are RealVista, a commission specialist helping ${userName} request and track commission information for South Florida properties.`;
    } else {
      systemPrompt = `You are RealVista, a commission specialist for South Florida real estate.

**⚠️ AUTHENTICATION REQUIRED**
Commission requests require user authentication. All commission tools will fail unless the user is logged in.`;
    }

    // Build search context if available
    const searchContext = searchId
      ? `\n**Current Search Session:**\n- searchId: "${searchId}"\n- Use this searchId when calling property_get_details`
      : '\n**No active search session** - property_get_details may not work without a searchId';

    const instructions = `
Your job: Use the available tools to help the user request and track commission information.
${searchContext}

**Available Tools:**

1. **property_get_details** - Get property details including listing agent info
   - Parameters: searchId (REQUIRED - use "${searchId || 'NO_SEARCH_ID'}"), listingKey (required)
   - Returns: Property data WITH listing agent email, name, phone
   - **IMPORTANT**: Use this FIRST before commission_request to get listingAgentEmail

2. **commission_request** - Request commission information from listing agent
   - Parameters: listingKey (required), propertyAddress (required), listingAgentEmail (required!), listingAgentName (optional), message (optional)
   - Use when: User wants to request commission info for a property
   - **IMPORTANT**: You MUST have listingAgentEmail before calling this!

3. **commission_list** - List user's commission requests
   - Parameters: status (optional: pending/responded/declined), limit (optional)
   - Use when: User asks to see their commission requests

4. **commission_unread_count** - Get count of unread commission responses
   - Parameters: none
   - Use when: User asks about new commission responses or updates

**Tool Execution Strategy:**

**⚠️ CRITICAL for commission_request:**
You MUST call property_get_details FIRST to get the listing agent's email before calling commission_request.

**Example workflow for commission request:**
1. User: "request commission info for property 1234567"
2. You: Call property_get_details(searchId: "${searchId || 'SEARCH_ID'}", listingKey: "1234567")
3. Get: {listAgentEmail: "agent@example.com", listAgentFullName: "John Smith", address: "123 Main St"}
4. You: Call commission_request(listingKey: "1234567", propertyAddress: "123 Main St", listingAgentEmail: "agent@example.com", listingAgentName: "John Smith")

**Other patterns:**
- "show my commission requests" → commission_list
- "any commission updates?" → commission_unread_count
- "check for updates and show all pending requests" → commission_unread_count → commission_list

**Critical Rules:**
1. **ALWAYS USE TOOLS** - Don't just respond with text. Execute the appropriate tools.
2. All tools require authentication (userId) - they will fail if user is not logged in
3. **ALWAYS get property_get_details first** before calling commission_request
3. For requesting commission, you need a listingKey and propertyAddress from property search results
4. Commission requests are sent via email to listing agents - responses come back async
5. Call tools as many times as needed to fully answer the user's query
6. Provide clear feedback about what was done and next steps
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
      console.log(`[Commissions] Tool loop iteration ${loopCount + 1}/${maxLoops}`);

      const response = await modelWithTools.invoke(currentMessages);

      // Check if tools were called
      if (response.tool_calls && response.tool_calls.length > 0) {
        console.log(`[Commissions] LLM requested ${response.tool_calls.length} tool(s): ${response.tool_calls.map(tc => tc.name).join(', ')}`);

        // Add AI message with tool calls to history
        currentMessages.push(response);

        // Execute each tool call
        for (const toolCall of response.tool_calls) {
          const tool = tools.find(t => t.name === toolCall.name);
          if (!tool) {
            console.error(`[Commissions] Tool ${toolCall.name} not found`);
            continue;
          }

          console.log(`[Commissions] Executing ${toolCall.name} with args:`, toolCall.args);

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
        console.log('[Commissions] No more tool calls - proceeding to response generation');
        break;
      }
    }

    if (loopCount >= maxLoops) {
      console.warn('[Commissions] Max tool loop iterations reached');
    }

    console.log('[Commissions] ✓ Tool execution completed, generating final response...');

    // Generate final response using a separate model
    const responseModel = createResponseModel();

    const responseInstructions = `
**Your job:** Create a concise, helpful response based on the commission operation results.

**Response Style:**
${isAuthenticated
        ? `- Address the user by their first name: ${firstName}
- Maintain a personal, conversational tone`
        : `- Use a friendly, professional tone`}
- Be concise and direct
- Use bullet points for key information
- Summarize what was done
- Explain commission request status and next steps
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

    console.log('[Commissions] ✓ Response generated');

    // Adapt response for non-web platforms
    if (platformContext.platform !== 'web') {
      finalResponse = adaptMarkdown(finalResponse, platformContext);
      finalResponse = truncateResponse(finalResponse, platformContext);
      console.log(`[Commissions] Response adapted for ${platformContext.platform} (${finalResponse.length} chars)`);
    }

    return {
      finalResponse,
      messages: [...toolMessages, new AIMessage({ content: finalResponse })],
      toolResults,
      platformContext,
    };
  } catch (error) {
    console.error('[Commissions] Error:', error);
    return {
      error: error instanceof Error ? error.message : 'Commission operation failed',
      finalResponse: 'I apologize, but I encountered an error with the commission operation. Please try again.',
    };
  }
}
