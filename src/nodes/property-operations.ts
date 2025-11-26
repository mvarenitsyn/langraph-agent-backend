import { AIMessage, HumanMessage, ToolMessage, SystemMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { AgentStateType } from "../types/state.js";
import { globalToolsRegistry } from "../tools/registry.js";
import { createToolCallingModel, createResponseModel } from "../models/openai.js";
import { uiEventPublisher } from "../pubsub/ui-event-publisher.js";
import { sharedPublisher } from "../pubsub/shared.js";

/**
 * Property Operations Node - Multi-Tool Agent
 *
 * This node is a specialized mini-agent that combines three property operation tools:
 * 1. property_filter_sort - Filter/sort existing search results with JavaScript
 * 2. property_get_results - Retrieve search results by searchId
 * 3. property_get_details - Get detailed information about a specific property
 *
 * Flow:
 * - Uses LLM with 3 tools bound
 * - LLM decides which tools to call, in what order, and how many times
 * - Can execute tools in parallel or sequential chains
 * - Generates final response after tool execution completes
 * - Publishes UI render events for each successful tool
 */
export async function propertyOperationsNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.log('\n[PropertyOperations] Starting property operations agent...');

  // Emit progress: Preparing operation
  await sharedPublisher.publishProgressUpdate({
    sessionId: state.metadata?.sessionId || '',
    userId: state.metadata?.userId,
    correlationId: state.metadata?.correlationId,
    status: 'Preparing operation...',
  });

  try {
    console.log('[PropertyOperations] state.messages count:', state.messages?.length || 0);
    console.log('[PropertyOperations] state.messages types:', state.messages?.map(m => {
      try {
        const type = m._getType();
        const isAI = type === 'ai';
        const hasToolCalls = isAI && (m as AIMessage).tool_calls && (m as AIMessage).tool_calls!.length > 0;
        return `${type}${hasToolCalls ? ` (${(m as AIMessage).tool_calls!.length} tool_calls)` : ''}`;
      } catch (e) {
        return `ERROR: ${e}`;
      }
    }).join(', ') || 'NONE');
  } catch (e) {
    console.error('[PropertyOperations] Error logging state.messages:', e);
  }

  const userContext = state.userContext || { isAuthenticated: false };
  const userName = userContext.fullName || 'there';
  const firstName = userName.split(' ')[0];
  const isAuthenticated = userContext.isAuthenticated || false;

  if (isAuthenticated && userContext.userId) {
    console.log(`[PropertyOperations] User: ${userName}`);
    console.log(`  - Listings: ${userContext.linkedListingsCount || 0}`);
    console.log(`  - Collections: ${userContext.collectionsCount || 0}`);
  }

  try {
    // Get all three property operation tools
    const filterSortTool = globalToolsRegistry.getTool('property_filter_sort');
    const getResultsTool = globalToolsRegistry.getTool('property_get_results');
    const getDetailsTool = globalToolsRegistry.getTool('property_get_details');

    if (!filterSortTool || !getResultsTool || !getDetailsTool) {
      const missing = [];
      if (!filterSortTool) missing.push('property_filter_sort');
      if (!getResultsTool) missing.push('property_get_results');
      if (!getDetailsTool) missing.push('property_get_details');
      throw new Error(`Required tools not found: ${missing.join(', ')}`);
    }

    // DEBUG: Verify tool has correct implementation
    console.log('[PropertyOperations] DEBUG: filterSortTool.name =', filterSortTool.name);
    console.log('[PropertyOperations] DEBUG: filterSortTool.func exists =', typeof filterSortTool.func === 'function');
    console.log('[PropertyOperations] DEBUG: filterSortTool.func =', filterSortTool.func.toString().substring(0, 200));

    // 🚨 FIX: Get searchId from metadata, preferring incomingSearchId (fresh from Pub/Sub)
    const searchId = state.metadata?.incomingSearchId || state.metadata?.searchId;

    console.log('[PropertyOperations] ====== SearchId Resolution ======');
    console.log('[PropertyOperations] incomingSearchId:', state.metadata?.incomingSearchId || 'NONE');
    console.log('[PropertyOperations] checkpointed searchId:', state.metadata?.searchId || 'NONE');
    console.log('[PropertyOperations] RESOLVED searchId:', searchId || 'NONE');

    if (!searchId) {
      console.warn('[PropertyOperations] ⚠️  No searchId in metadata - tools may fail');
    } else {
      console.log(`[PropertyOperations] ✓ SearchId available: ${searchId}`);
    }

    // Wrap each tool to inject searchId
    const wrappedTools = [
      // Wrap filter/sort tool
      new DynamicStructuredTool({
        name: filterSortTool.name,
        description: filterSortTool.description,
        schema: (filterSortTool.schema as z.ZodObject<any>).omit({ searchId: true }), // Remove searchId from schema
        func: async (args, config) => {
          // Call original tool with searchId injected
          // IMPORTANT: Apply default for saveResults since .omit() loses defaults
          const argsWithDefaults = {
            ...args,
            searchId,
            saveResults: args.saveResults !== undefined ? args.saveResults : true,
          };
          const result = await filterSortTool.func(argsWithDefaults, config);
          return result;
        }
      }),
      // Wrap get results tool
      new DynamicStructuredTool({
        name: getResultsTool.name,
        description: getResultsTool.description,
        schema: (getResultsTool.schema as z.ZodObject<any>).omit({ searchId: true }),
        func: async (args, config) => {
          return getResultsTool.func({ ...args, searchId }, config);
        }
      }),
      // Wrap get details tool
      new DynamicStructuredTool({
        name: getDetailsTool.name,
        description: getDetailsTool.description,
        schema: (getDetailsTool.schema as z.ZodObject<any>).omit({ searchId: true }),
        func: async (args, config) => {
          return getDetailsTool.func({ ...args, searchId }, config);
        }
      })
    ];

    console.log('[PropertyOperations] ✓ Tools wrapped with searchId:', wrappedTools.map(t => t.name).join(', '));
    console.log(`[PropertyOperations] Binding ${wrappedTools.length} tools to LLM`);

    // Create model with wrapped tools bound
    const toolModel = createToolCallingModel();
    const modelWithTools = toolModel.bindTools(wrappedTools);

    console.log('[PropertyOperations] ✓ Tools bound to model successfully');

    // Build rich system prompt with user context
    let systemPrompt = '';

    if (isAuthenticated) {
      systemPrompt = `You are RealVista, a property operations specialist helping ${userName} work with property search results in South Florida.`;

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
      systemPrompt = `You are RealVista, a property operations specialist for South Florida real estate.`;
    }

    const instructions = `
Your job: Use the available tools to help the user work with property search results.

**IMPORTANT**: You have an active search session - searchId is automatically provided to all tools.
You do NOT need to specify searchId when calling tools - it's auto-injected!

**Available Tools:**

1. **property_filter_sort** - Filter/sort search results with JavaScript code
   - Use when: User wants to narrow down, refine, filter, or sort properties
   - Parameters: Just provide the JavaScript code to execute
   - Examples: "under $500k", "sort by price", "3+ bedrooms", "waterfront only"

2. **property_get_results** - Retrieve current search results
   - Use when: User asks "what did we find?", "show me the results", "what properties?"
   - Parameters: No parameters needed (includeFiltered optional)
   - Returns: List of properties from the active search

3. **property_get_details** - Get full details for a specific property
   - Use when: User asks about a specific property
   - Parameters: Just provide listingKey OR address
   - Returns: Complete property information (all 50+ MLS fields)
   - Examples: "tell me about 123 Main St", "details on the first property"

**Tool Execution Strategy:**

You can call tools in ANY ORDER based on the user's query. Common patterns:

**Single tool**:
- "filter to under $500k" → property_filter_sort

**Sequential chain**:
- "filter to 3BR and show me the cheapest" → property_filter_sort → property_get_results → property_get_details
- "show me the search results and tell me about the first one" → property_get_results → property_get_details

**Multiple iterations**:
- "filter to waterfront, then to under $1M, then show me the best one" →
  property_filter_sort (waterfront) → property_filter_sort (price) → property_get_results → property_get_details

**Critical Rules:**
1. **ALWAYS USE TOOLS** - Don't just respond with text. The user expects tools to be executed.
2. If searchId is available (shown above), you MUST use property_filter_sort or property_get_results
3. For property_get_details, you need BOTH searchId AND (listingKey OR address)
4. Use property_get_results first if you need to see what properties are available
5. Call tools as many times as needed to fully answer the user's query
6. Don't apologize about missing data - just call the tools to get it!

**Available Property Fields:**
- Basic: ListingKey, UnparsedAddress, ListPrice, BedroomsTotal, BathroomsTotalInteger
- Size: LivingArea, LotSizeSquareFeet
- Features: PoolYN, WaterfrontYN, GarageSpaces, FireplacesTotal
- Financial: AssociationFee, TaxAnnualAmount
- Status: StandardStatus, DaysOnMarket, ListingContractDate
- Plus 40+ more MLS fields

The UI will automatically render based on tool results:
- property_filter_sort → Updates search results with filtered list
- property_get_results → Displays property list on map/listview
- property_get_details → Opens property details modal
`;

    // Start fresh without conversation history to avoid OpenAI tool message errors
    // The searchId is in state.metadata, so we don't need conversation history
    // This prevents orphaned ToolMessages from previous executions
    const latestUserMessage = new HumanMessage({ content: state.message });

    let currentMessages: (SystemMessage | HumanMessage | AIMessage | ToolMessage)[] = [
      new SystemMessage({ content: `${systemPrompt}\n${instructions}` }),
      latestUserMessage,  // Only the current message - no history
    ];

    console.log(`[PropertyOperations] Starting fresh (no conversation history to avoid tool message errors)`);

    const toolResults: Record<string, any> = {};
    const toolMessages: ToolMessage[] = [];
    let loopCount = 0;
    const maxLoops = 5; // Allow up to 5 tool calls for complex chains

    // Tool execution loop
    while (loopCount < maxLoops) {
      loopCount++;
      console.log(`[PropertyOperations] 🔄 Tool loop iteration ${loopCount}/${maxLoops}`);

      const responseWithTools = await modelWithTools.invoke(currentMessages);

      // Check if LLM wants to call tools
      if (responseWithTools.tool_calls && responseWithTools.tool_calls.length > 0) {
        console.log(`[PropertyOperations] LLM called ${responseWithTools.tool_calls.length} tool(s)`);

        // Execute ALL tool calls
        const toolCallResults = await Promise.all(
          responseWithTools.tool_calls.map(async (toolCall) => {
            const tool = wrappedTools.find((t) => t.name === toolCall.name);
            if (!tool) {
              return {
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                result: `Tool ${toolCall.name} not found`,
              };
            }

            console.log(`[PropertyOperations] Executing tool: ${toolCall.name}`);
            console.log(`[PropertyOperations] Tool args:`, JSON.stringify(toolCall.args, null, 2));
            console.log(`[PropertyOperations] SearchId pre-injected: ${searchId}`);

            const result = await tool.func(toolCall.args);

            // Check if tool execution was successful
            try {
              const parsedResult = typeof result === 'string' ? JSON.parse(result) : result;
              if (parsedResult.success === false || parsedResult.error) {
                console.error(`[PropertyOperations] ❌ Tool ${toolCall.name} failed:`, parsedResult.error || parsedResult.message);
                console.error(`[PropertyOperations] Failed args:`, toolCall.args);
              } else {
                console.log(`[PropertyOperations] ✓ Tool ${toolCall.name} completed successfully`);
              }
            } catch (parseError) {
              // If not JSON, assume success
              console.log(`[PropertyOperations] ✓ Tool ${toolCall.name} completed`);
            }

            // Store result for final return and UI rendering
            toolResults[toolCall.name] = result;

            return {
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              result,
            };
          })
        );

        // Create ToolMessages for each tool call result
        const newToolMessages = toolCallResults.map(
          ({ toolCallId, result }) =>
            new ToolMessage({
              content: typeof result === 'string' ? result : JSON.stringify(result),
              tool_call_id: toolCallId,
            })
        );

        toolMessages.push(...newToolMessages);

        // Update message history: add AIMessage with tool_calls + ToolMessages
        currentMessages.push(responseWithTools, ...newToolMessages);
      } else {
        // No more tool calls - break the loop
        console.log('[PropertyOperations] ✓ No more tool calls - completing');
        break;
      }
    }

    if (loopCount >= maxLoops) {
      console.warn('[PropertyOperations] Max tool loop iterations reached');
    }

    console.log('[PropertyOperations] ✓ Tool execution completed, generating final response...');

    // Publish UI render events for successful tool executions
    await publishUIEventsForTools(toolResults, state);

    // Generate final response using a separate model
    const responseModel = createResponseModel();

    const responseInstructions = `
**Your job:** Create a concise, helpful response based on the tool execution results.

**Response Style:**
${isAuthenticated
        ? `- Address the user by their first name: ${firstName}
- Maintain a personal, conversational tone`
        : `- Use a friendly, professional tone`}
- Be concise and direct
- Use bullet points for key information
- Summarize what was done and what was found
- If property details were retrieved, highlight key features
- End with 1-2 clear next step suggestions

Generate a focused response based on the tool results below.
`;

    // Clean message history for response generation
    // Create a summary of tool execution results for the response model
    const toolExecutionSummary = Object.entries(toolResults)
      .map(([toolName, result]) => {
        const parsedResult = typeof result === 'string' ? JSON.parse(result) : result;
        return `Tool: ${toolName}\nResult: ${JSON.stringify(parsedResult, null, 2)}`;
      })
      .join('\n\n');

    const responseMessages = [
      new SystemMessage({ content: `${systemPrompt}\n${responseInstructions}` }),
      latestUserMessage,        // User's original query
      new HumanMessage({ content: `Tool Execution Results:\n\n${toolExecutionSummary}` }),
    ];

    const finalResponseMsg = await responseModel.invoke(responseMessages);
    const finalResponse = finalResponseMsg.content as string;

    console.log('[PropertyOperations] ✓ Response generated');

    // CRITICAL: Don't return messages! LangGraph's concat reducer will add these
    // to existing state.messages which may already contain orphaned ToolMessages
    // from previous failed executions, causing OpenAI API errors.
    // Let LangGraph manage conversation history naturally.
    return {
      finalResponse,
      toolResults,
    };
  } catch (error) {
    console.error('[PropertyOperations] Error:', error);
    return {
      error: error instanceof Error ? error.message : 'Property operations failed',
      finalResponse: 'I apologize, but I encountered an error performing the property operations. Please try again.',
    };
  }
}

/**
 * Publish UI render events for successful tool executions
 */
async function publishUIEventsForTools(toolResults: Record<string, any>, state: AgentStateType): Promise<void> {
  console.log('[PropertyOperations] Publishing UI events for tool results...');

  const sessionId = state.metadata?.sessionId || 'unknown';
  const userId = state.metadata?.userId;
  const correlationId = state.metadata?.correlationId || state.metadata?.sessionId || 'unknown';

  // Check each tool result and publish appropriate UI event
  for (const [toolName, resultStr] of Object.entries(toolResults)) {
    try {
      console.log(`[PropertyOperations] Processing tool result for: ${toolName}`);
      console.log(`[PropertyOperations] Result type: ${typeof resultStr}`);
      console.log(`[PropertyOperations] Result preview: ${JSON.stringify(resultStr).substring(0, 200)}...`);

      const result = JSON.parse(resultStr);

      console.log(`[PropertyOperations] Parsed result.success: ${result.success}`);
      console.log(`[PropertyOperations] Parsed result.data exists: ${!!result.data}`);
      console.log(`[PropertyOperations] Parsed result.data.searchId: ${result.data?.searchId}`);
      console.log(`[PropertyOperations] Parsed result.data.totalCount: ${result.data?.totalCount}`);

      if (!result.success) {
        console.log(`[PropertyOperations] Skipping UI event for failed tool: ${toolName}`);
        continue;
      }

      // property_filter_sort → filtered_results
      if (toolName === 'property_filter_sort' && result.count !== undefined && result.searchId) {
        console.log(`[PropertyOperations] Publishing filtered_results event for ${result.count} properties`);

        await uiEventPublisher.publishUIEvent({
          renderType: 'filtered_results',
          data: {
            searchId: result.searchId,
            totalCount: result.count,
            filterType: 'custom',
          },
          sessionId,
          userId,
          correlationId,
        });

        console.log('[PropertyOperations] ✓ filtered_results event published');
      }

      // property_get_results → search_results (only if count > 0)
      else if (toolName === 'property_get_results' && result.totalCount > 0 && result.data?.searchId) {
        console.log(`[PropertyOperations] Publishing search_results event for ${result.totalCount} properties`);

        await uiEventPublisher.publishUIEvent({
          renderType: 'search_results',
          data: {
            searchId: result.data.searchId,
            totalCount: result.totalCount,
            isFiltered: result.isFiltered || false,
          },
          sessionId,
          userId,
          correlationId,
        });

        console.log('[PropertyOperations] ✓ search_results event published');
      }

      // property_get_details → property_details
      else if (toolName === 'property_get_details' && result.property && result.searchId) {
        const property = result.property;
        const listingKey = property.ListingKey;

        console.log(`[PropertyOperations] Publishing property_details event for ${listingKey}`);

        await uiEventPublisher.publishUIEvent({
          renderType: 'property_details',
          data: {
            searchId: result.searchId,
            listingKey,
            property, // Include full property data to avoid extra fetch
          },
          sessionId,
          userId,
          correlationId,
        });

        console.log('[PropertyOperations] ✓ property_details event published');
      }
    } catch (error) {
      console.error(`[PropertyOperations] Failed to publish UI event for ${toolName}:`, error);
      // Don't fail the request if UI event publishing fails
    }
  }
}
