import { AIMessage, HumanMessage, ToolMessage, SystemMessage } from "@langchain/core/messages";
import { AgentStateType } from "../types/state.js";
import { globalToolsRegistry } from "../tools/registry.js";
import { createResponseModel } from "../models/openai.js";
import { uiEventPublisher } from "../pubsub/ui-event-publisher.js";
import { sharedPublisher } from "../pubsub/shared.js";
import { getPlatformContext, shouldPublishUIEvents } from "../utils/platformContext.js";
import { buildFormattingInstructions, adaptMarkdown, truncateResponse } from "../utils/formatters.js";

/**
 * Property Search Node - Optimized Direct Tool Execution
 *
 * PERFORMANCE OPTIMIZATION:
 * This node directly executes the property_search tool WITHOUT an LLM decision step.
 * We already know we need to search (router sent us here), so we skip the unnecessary
 * "should I call the tool?" LLM call that was costing 1-2 seconds.
 *
 * Flow:
 * 1. DIRECTLY call property_search tool with user query (no LLM decision)
 * 2. Generate user-friendly response from results
 *
 * Previous flow (SLOW):
 * 1. LLM decides to call tool (1-2s) ❌ REMOVED
 * 2. Execute tool (12s)
 * 3. LLM generates response (5-6s)
 *
 * New flow (FAST):
 * 1. Execute tool directly (12s)
 * 2. LLM generates response (5-6s)
 *
 * Savings: 1-2 seconds per search
 */
export async function propertySearchNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.log('\n[PropertySearch] Starting property search agent (OPTIMIZED - direct tool execution)...');

  // Emit progress: Searching MLS
  await sharedPublisher.publishProgressUpdate({
    sessionId: state.metadata?.sessionId || '',
    userId: state.metadata?.userId,
    correlationId: state.metadata?.correlationId,
    status: 'Searching MLS...',
  });

  const userContext = state.userContext || { isAuthenticated: false };
  const userName = userContext.fullName || 'there';
  const firstName = userName.split(' ')[0];
  const isAuthenticated = userContext.isAuthenticated || false;

  // Resolve platform context
  const platformContext = getPlatformContext(state);
  console.log(`[PropertySearch] Platform: ${platformContext.platform} (supportsRichUI: ${platformContext.capabilities.supportsRichUI})`);

  if (isAuthenticated && userContext.userId) {
    console.log(`[PropertySearch] User: ${userName}`);
    console.log(`  - Listings: ${userContext.linkedListingsCount || 0}`);
    console.log(`  - Collections: ${userContext.collectionsCount || 0}`);
  }

  try {
    // Get property search tool
    const propertySearchTool = globalToolsRegistry.getTool('property_search');

    if (!propertySearchTool) {
      throw new Error('property_search tool not found');
    }

    console.log('[PropertySearch] ✓ Tool registered: property_search');
    console.log('[PropertySearch] ⚡ OPTIMIZATION: Skipping LLM tool binding - calling tool directly');

    // OPTIMIZATION: Directly execute the property_search tool WITHOUT LLM decision
    // We already know we need to search (router routed us here), so skip the "should I call tool?" step
    console.log(`[PropertySearch] Executing property_search with query: "${state.message}"`);

    const startTime = Date.now();
    const result = await propertySearchTool.invoke(
      { query: state.message },
      {
        metadata: {
          sessionId: state.metadata?.sessionId,
          userId: state.metadata?.userId,
          userContext: state.userContext,
        },
      }
    );
    const toolExecutionTime = Date.now() - startTime;
    console.log(`[PropertySearch] ⏱️  Tool execution time: ${toolExecutionTime}ms`);

    const resultStr = typeof result === 'string' ? result : JSON.stringify(result);

    // Store result
    const toolResults: Record<string, any> = {
      property_search: resultStr,
    };

    // Create AI message with tool call (required by OpenAI API)
    // Even though we called the tool directly, we need to create this for the conversation history
    const toolCallId = `property_search_${Date.now()}`;
    const aiMessageWithToolCall = new AIMessage({
      content: '',
      tool_calls: [{
        id: toolCallId,
        name: 'property_search',
        args: { query: state.message },
        type: 'tool_call' as const,
      }],
    });

    // Create tool message for conversation history
    const toolMessage = new ToolMessage({
      content: resultStr,
      tool_call_id: toolCallId,
      name: 'property_search',
    });

    // Log search results and extract searchId
    try {
      const resultObj = typeof result === 'string' ? JSON.parse(result) : result;
      const totalCount = resultObj?.totalCount || 0;
      const searchId = resultObj?.searchId;

      console.log(`[PropertySearch] Search completed with ${totalCount} properties (backend handled retries if needed)`);

      // Extract and store searchId and totalCount in metadata for downstream tools
      if (searchId) {
        console.log(`[PropertySearch] ✓ Extracted searchId: ${searchId}, totalCount: ${totalCount} - storing in metadata`);
        state.metadata = {
          ...state.metadata,
          lastSearchId: state.metadata?.searchId,  // Preserve previous searchId
          searchId: searchId,  // Update to new searchId
          totalCount: totalCount,  // Include total count for UI events
        };
      }
    } catch (parseError) {
      console.warn('[PropertySearch] Could not parse property_search result:', parseError);
    }

    console.log('[PropertySearch] ✓ Tool execution completed, generating final response...');

    // Generate final response using a separate model
    const responseModel = createResponseModel();

    // Build system prompt
    let systemPrompt = '';
    if (isAuthenticated) {
      systemPrompt = `You are RealVista, a property search specialist helping ${userName} find properties in South Florida.`;

      const contextParts = [];
      if (userContext.linkedListingsCount && userContext.linkedListingsCount > 0) {
        contextParts.push(`${userContext.linkedListingsCount} listings`);
      }
      if (userContext.collectionsCount && userContext.collectionsCount > 0) {
        contextParts.push(`${userContext.collectionsCount} collections`);
      }

      if (contextParts.length > 0) {
        systemPrompt += `\n\n**${firstName}'s Account:** ${contextParts.join(', ')}`;
      }
    } else {
      systemPrompt = `You are RealVista, a property search specialist for South Florida real estate.`;
    }

    // Add platform-specific formatting instructions
    const platformFormattingInstructions = buildFormattingInstructions(platformContext);

    const responseInstructions = `
**Your job:** Create a concise, helpful response based on the property search results.

**Response Style:**
${isAuthenticated
        ? `- Address the user by their first name: ${firstName}
- Maintain a personal, conversational tone`
        : `- Use a friendly, professional tone`}
- Be concise and direct
- Use bullet points for key information
- Lead with key numbers (count, price range)
- End with 1-2 clear next step suggestions

${platformFormattingInstructions}

Generate a focused response based on the tool results below.
`;

    // Create response generation messages
    // Include user query, AI message with tool call, and tool result
    const latestUserMessage = new HumanMessage({ content: state.message });

    const responseMessages = [
      new SystemMessage({ content: `${systemPrompt}\n${responseInstructions}` }),
      latestUserMessage,
      aiMessageWithToolCall,  // AI message with tool_calls (required by OpenAI)
      toolMessage,  // Tool result
    ];

    const responseStart = Date.now();
    const finalResponseMsg = await responseModel.invoke(responseMessages);
    const responseGenerationTime = Date.now() - responseStart;
    console.log(`[PropertySearch] ⏱️  Response generation time: ${responseGenerationTime}ms`);

    let finalResponse = finalResponseMsg.content as string;

    console.log('[PropertySearch] ✓ Response generated');

    // Adapt response for non-web platforms
    if (platformContext.platform !== 'web') {
      finalResponse = adaptMarkdown(finalResponse, platformContext);
      finalResponse = truncateResponse(finalResponse, platformContext);
      console.log(`[PropertySearch] Response adapted for ${platformContext.platform} (${finalResponse.length} chars)`);
    }

    // Publish UI render event if we have search results (only for platforms that support UI)
    const propertySearchResult = toolResults?.['property_search'];
    if (propertySearchResult && shouldPublishUIEvents(platformContext)) {
      try {
        const result = JSON.parse(propertySearchResult);
        if (result.success && result.totalCount > 0 && result.searchId) {
          console.log(`[PropertySearch] Publishing UI render event for ${result.totalCount} properties`);

          await uiEventPublisher.publishSearchResults({
            searchId: result.searchId,
            totalCount: result.totalCount,
            searchToken: result.searchToken,
            mapLink: result.mapLink,
            sessionId: state.metadata?.sessionId || 'unknown',
            userId: state.metadata?.userId,
            correlationId: state.metadata?.correlationId || state.metadata?.sessionId || 'unknown',
          });

          console.log('[PropertySearch] ✓ UI render event published');
        }
      } catch (error) {
        console.error('[PropertySearch] Failed to publish UI render event:', error);
        // Don't fail the request if UI event publishing fails
      }
    } else if (propertySearchResult) {
      console.log('[PropertySearch] Skipping UI render event for non-web platform');
    }

    const totalNodeTime = Date.now() - startTime;
    console.log(`[PropertySearch] ⏱️  Total node time: ${totalNodeTime}ms (tool: ${toolExecutionTime}ms, response: ${responseGenerationTime}ms)`);

    return {
      finalResponse,
      messages: [aiMessageWithToolCall, toolMessage, new AIMessage({ content: finalResponse })],
      toolResults,
      metadata: state.metadata,  // Include updated metadata with searchId
      platformContext,
    };
  } catch (error) {
    console.error('[PropertySearch] Error:', error);
    return {
      error: error instanceof Error ? error.message : 'Property search failed',
      finalResponse: 'I apologize, but I encountered an error searching for properties. Please try again.',
    };
  }
}
