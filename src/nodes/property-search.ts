import { AIMessage, HumanMessage, ToolMessage, SystemMessage } from "@langchain/core/messages";
import { AgentStateType } from "../types/state.js";
import { globalToolsRegistry } from "../tools/registry.js";
import { createToolCallingModel, createResponseModel } from "../models/openai.js";
import { uiEventPublisher } from "../pubsub/ui-event-publisher.js";
import { sharedPublisher } from "../pubsub/shared.js";
import { getPlatformContext, shouldPublishUIEvents } from "../utils/platformContext.js";
import { buildFormattingInstructions, adaptMarkdown, truncateResponse } from "../utils/formatters.js";

/**
 * Property Search Node - Mini Agent with Tool Loop
 *
 * This node is a specialized mini-agent that uses:
 * 1. property_search - Search the MLS API
 *
 * Flow:
 * - Uses LLM with property_search tool bound
 * - Can call the tool multiple times if needed
 * - Generates final response after search completes
 */
export async function propertySearchNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.log('\n[PropertySearch] Starting property search agent...');

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

    const tools = [propertySearchTool];
    console.log('[PropertySearch] ✓ Tool registered: property_search');
    console.log(`[PropertySearch] Binding ${tools.length} tool to LLM: ${tools.map(t => t.name).join(', ')}`);

    // Create model with tools bound
    const toolModel = createToolCallingModel();
    const modelWithTools = toolModel.bindTools(tools);

    console.log('[PropertySearch] ✓ Tools bound to model successfully');

    // Build rich system prompt with user context
    let systemPrompt = '';

    if (isAuthenticated) {
      systemPrompt = `You are RealVista, a property search specialist helping ${userName} find properties in South Florida.`;

      // Add user context summary
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

    const instructions = `
Your job: Use the property_search tool to find properties and answer the user's query.

**Available Tool:**
- **property_search** - Search MLS listings using natural language queries

**How It Works:**
The property_search tool uses an intelligent backend mapper that automatically converts natural language queries into precise MLS filters. You simply pass the user's query, and the backend handles all the technical details.

**Examples:**
- "2 bedroom condos in Miami under 500k"
- "luxury waterfront homes in Aventura"
- "3+ bedroom houses in Fort Lauderdale"

**Automatic Zero-Result Retry:**
The backend automatically handles zero-result searches with a 2-tier retry strategy:
- **Tier 1**: Remove StandardStatus filter (e.g., "Active" only) to include all statuses
- **Tier 2**: Keep only core location fields (StreetNumber, StreetName, UnitNumber, City, PostalCode)

You don't need to manage retries - just call property_search once and the backend will handle the rest.
`;

    // Include conversation history to remember user preferences and context
    // This enables personalized search recommendations based on previous interactions
    const previousMessages = state.messages || [];
    const latestUserMessage = new HumanMessage({ content: state.message });

    let currentMessages = [
      new SystemMessage({ content: `${systemPrompt}\n${instructions}` }),
      ...previousMessages, // Include full conversation history from checkpoint
      latestUserMessage,
    ];

    // Track where the current turn's tool loop starts (after all previous messages)
    const toolLoopStartIndex = 1 + previousMessages.length + 1; // SystemMessage + previousMessages + latestUserMessage

    const toolResults: Record<string, any> = {};
    const toolMessages: ToolMessage[] = [];
    let loopCount = 0;
    const maxLoops = 1; // Single call only - backend handles retries

    // Tool execution loop
    while (loopCount < maxLoops) {
      console.log(`[PropertySearch] Tool loop iteration ${loopCount + 1}/${maxLoops}`);

      const response = await modelWithTools.invoke(currentMessages);

      // Check if tools were called
      if (response.tool_calls && response.tool_calls.length > 0) {
        console.log(`[PropertySearch] LLM requested ${response.tool_calls.length} tool(s): ${response.tool_calls.map(tc => tc.name).join(', ')}`);

        // Add AI message with tool calls to history
        currentMessages.push(response);

        // Execute each tool call
        for (const toolCall of response.tool_calls) {
          const tool = tools.find(t => t.name === toolCall.name);
          if (!tool) {
            console.error(`[PropertySearch] Tool ${toolCall.name} not found`);
            continue;
          }

          console.log(`[PropertySearch] Executing ${toolCall.name} with args:`, toolCall.args);
          const result = await tool.invoke(toolCall.args, {
            metadata: {
              sessionId: state.metadata?.sessionId,
              userId: state.metadata?.userId,
              userContext: state.userContext,
            },
          });
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

          // Log search results and extract searchId (backend handles retries automatically)
          if (toolCall.name === 'property_search') {
            try {
              const resultObj = typeof result === 'string' ? JSON.parse(result) : result;
              const totalCount = resultObj?.totalCount || 0;
              const searchId = resultObj?.searchId;

              console.log(`[PropertySearch] Search completed with ${totalCount} properties (backend handled retries if needed)`);

              // Extract and store searchId and totalCount in metadata for downstream tools
              if (searchId) {
                console.log(`[PropertySearch] ✓ Extracted searchId: ${searchId}, totalCount: ${totalCount} - storing in metadata`);
                // Note: This will be returned at the end of the node
                // We store it in a variable to return after tool loop completes
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
          }
        }

        loopCount++;
      } else {
        // No more tool calls - exit loop
        console.log('[PropertySearch] No more tool calls - proceeding to response generation');
        break;
      }
    }

    if (loopCount >= maxLoops) {
      console.warn('[PropertySearch] Max tool loop iterations reached');
    }

    console.log('[PropertySearch] ✓ Tool execution completed, generating final response...');

    // Generate final response using a separate model
    const responseModel = createResponseModel();

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

    // Clean message history for response generation
    // Include user query + COMPLETE tool loop conversation (AIMessages with tool_calls + ToolMessages)
    // Extract tool loop conversation from currentMessages (after the initial setup)
    const toolLoopConversation = currentMessages.slice(toolLoopStartIndex); // Skip initial messages

    const responseMessages = [
      new SystemMessage({ content: `${systemPrompt}\n${responseInstructions}` }),
      latestUserMessage,        // User's original query
      ...toolLoopConversation,  // Complete tool loop: AIMessages + ToolMessages
    ];

    const finalResponseMsg = await responseModel.invoke(responseMessages);
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

    return {
      finalResponse,
      messages: [...toolMessages, new AIMessage({ content: finalResponse })],
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
