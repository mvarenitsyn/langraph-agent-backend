import { AIMessage, HumanMessage, ToolMessage, SystemMessage } from "@langchain/core/messages";
import { AgentStateType } from "../types/state.js";
import { globalToolsRegistry } from "../tools/registry.js";
import { createToolCallingModel, createResponseModel } from "../models/openai.js";
import { uiEventPublisher } from "../pubsub/ui-event-publisher.js";

/**
 * Property Filter/Sort Node - Mini Agent with Tool Loop
 *
 * This node is a specialized mini-agent that uses:
 * 1. property_filter_sort - Filter/sort existing search results
 *
 * Flow:
 * - Uses LLM with property_filter_sort tool bound
 * - Can call the tool multiple times if needed
 * - Generates final response after filtering/sorting completes
 * - Publishes UI render event for filtered results
 */
export async function propertyFilterSortNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.log('\n[PropertyFilterSort] Starting filter/sort agent...');

  const userContext = state.userContext || { isAuthenticated: false };
  const userName = userContext.fullName || 'there';
  const firstName = userName.split(' ')[0];
  const isAuthenticated = userContext.isAuthenticated || false;

  try {
    // Get property_filter_sort tool
    const filterSortTool = globalToolsRegistry.getTool('property_filter_sort');

    if (!filterSortTool) {
      throw new Error('property_filter_sort tool not found');
    }

    const tools = [filterSortTool];
    console.log('[PropertyFilterSort] ✓ Tool registered: property_filter_sort');
    console.log(`[PropertyFilterSort] Binding ${tools.length} tool to LLM: ${tools.map(t => t.name).join(', ')}`);

    // Create model with tools bound
    const toolModel = createToolCallingModel();
    const modelWithTools = toolModel.bindTools(tools);

    console.log('[PropertyFilterSort] ✓ Tools bound to model successfully');

    const systemPrompt = isAuthenticated
      ? `You are RealVista, a property search specialist helping ${userName} filter and sort properties in South Florida.`
      : `You are RealVista, a property search specialist for South Florida real estate.`;

    const instructions = `
Your job: Use the property_filter_sort tool to filter/sort existing search results based on the user's request.

**CRITICAL:**
1. The user is asking to filter/sort properties from a PREVIOUS search
2. You MUST get the searchId from the conversation history (check previous messages for property_search results)
3. Generate JavaScript code to filter/sort the properties array
4. ALWAYS use "return" statement in your code
5. The tool will save results to database and publish UI render event automatically

**Common filter/sort patterns:**

Price filters:
- "under $500k" → return properties.filter(p => p.ListPrice < 500000)
- "between $400k and $600k" → return properties.filter(p => p.ListPrice >= 400000 && p.ListPrice <= 600000)

Bedroom/bathroom filters:
- "3 bedrooms or more" → return properties.filter(p => p.BedroomsTotal >= 3)
- "at least 2 bathrooms" → return properties.filter(p => p.BathroomsTotalInteger >= 2)

Sorting:
- "sort by price" → return properties.sort((a, b) => a.ListPrice - b.ListPrice)
- "highest price first" → return properties.sort((a, b) => b.ListPrice - a.ListPrice)
- "sort by size" → return properties.sort((a, b) => (b.LivingArea || 0) - (a.LivingArea || 0))

Combined filter + sort:
- "3 bedrooms under $500k, sorted by price" → return properties.filter(p => p.BedroomsTotal >= 3 && p.ListPrice < 500000).sort((a, b) => a.ListPrice - b.ListPrice)

**Available property fields:**
- ListPrice, BedroomsTotal, BathroomsTotalInteger, LivingArea
- City, StateOrProvince, PostalCode
- UnparsedAddress, StreetName, UnitNumber
- YearBuilt, PropertySubType, StandardStatus
- And 50+ other MLS fields

**IMPORTANT:**
- If you can't find searchId from conversation, ask user to search for properties first
- Always use proper JavaScript syntax with return statement
- Don't try to access properties that don't exist
- Use safe navigation (|| 0) for numeric fields that might be null
`;

    // Start with CLEAN message history - only get the latest user query
    // Don't inherit router's internal decision messages (which might have unresolved tool_calls)
    const latestUserMessage = state.messages && state.messages.length > 0
      ? state.messages[state.messages.length - 1]
      : new HumanMessage({ content: state.message });

    let currentMessages = [
      new SystemMessage({ content: `${systemPrompt}\n${instructions}` }),
      latestUserMessage,
    ];

    const toolResults: Record<string, any> = {};
    const toolMessages: ToolMessage[] = [];
    let loopCount = 0;
    const maxLoops = 3;

    // Tool execution loop
    while (loopCount < maxLoops) {
      loopCount++;
      console.log(`[PropertyFilterSort] 🔄 Tool loop iteration ${loopCount}/${maxLoops}`);

      const responseWithTools = await modelWithTools.invoke(currentMessages);

      // Check if LLM wants to call tools
      if (responseWithTools.tool_calls && responseWithTools.tool_calls.length > 0) {
        console.log(`[PropertyFilterSort] LLM called ${responseWithTools.tool_calls.length} tool(s)`);

        // Execute ALL tool calls
        const toolCallResults = await Promise.all(
          responseWithTools.tool_calls.map(async (toolCall) => {
            const tool = tools.find((t) => t.name === toolCall.name);
            if (!tool) {
              return {
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                result: `Tool ${toolCall.name} not found`,
              };
            }

            console.log(`[PropertyFilterSort] Executing tool: ${toolCall.name}`);
            const result = await tool.func(toolCall.args);
            console.log(`[PropertyFilterSort] ✓ Tool ${toolCall.name} completed`);

            // Store result for final return
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
        console.log('[PropertyFilterSort] ✓ No more tool calls - completing');
        break;
      }
    }

    if (loopCount >= maxLoops) {
      console.warn('[PropertyFilterSort] Max tool loop iterations reached');
    }

    console.log('[PropertyFilterSort] ✓ Tool execution completed, generating final response...');

    // Generate final response using a separate model
    const responseModel = createResponseModel();

    const responseInstructions = `
**Your job:** Create a concise, helpful response based on the filter/sort results.

**Response Style:**
${isAuthenticated
        ? `- Address the user by their first name: ${firstName}
- Maintain a personal, conversational tone`
        : `- Use a friendly, professional tone`}
- Be concise and direct
- Use bullet points for key information
- Lead with the count of filtered/sorted properties
- Mention key statistics (price range, bedroom range, etc.)
- End with 1-2 clear next step suggestions

Generate a focused response based on the tool results below.
`;

    // Clean message history for response generation
    // Include user query + COMPLETE tool loop conversation (AIMessages with tool_calls + ToolMessages)
    // Extract tool loop conversation from currentMessages (skip the initial SystemMessage + HumanMessage)
    const toolLoopConversation = currentMessages.slice(2); // Skip [SystemMessage, HumanMessage]

    const responseMessages = [
      new SystemMessage({ content: `${systemPrompt}\n${responseInstructions}` }),
      latestUserMessage,        // User's original query
      ...toolLoopConversation,  // Complete tool loop: AIMessages + ToolMessages
    ];

    const finalResponseMsg = await responseModel.invoke(responseMessages);
    const finalResponse = finalResponseMsg.content as string;

    console.log('[PropertyFilterSort] ✓ Response generated');

    // Publish UI render event if we have filtered results
    const filterSortResult = toolResults?.['property_filter_sort'];
    if (filterSortResult) {
      try {
        const result = JSON.parse(filterSortResult);
        if (result.success && result.data?.totalCount !== undefined && result.data?.searchId) {
          console.log(`[PropertyFilterSort] Publishing UI render event for ${result.data.totalCount} filtered properties`);

          await uiEventPublisher.publishUIEvent({
            renderType: 'filtered_results',
            data: {
              searchId: result.data.searchId,
              totalCount: result.data.totalCount,
              filterType: 'custom',
            },
            sessionId: state.metadata?.sessionId || 'unknown',
            userId: state.metadata?.userId,
            correlationId: state.metadata?.correlationId || state.metadata?.sessionId || 'unknown',
          });

          console.log('[PropertyFilterSort] ✓ UI render event published');
        }
      } catch (error) {
        console.error('[PropertyFilterSort] Failed to publish UI render event:', error);
        // Don't fail the request if UI event publishing fails
      }
    }

    return {
      finalResponse,
      messages: [...toolMessages, new AIMessage({ content: finalResponse })],
      toolResults,
    };
  } catch (error) {
    console.error('[PropertyFilterSort] Error:', error);
    return {
      error: error instanceof Error ? error.message : 'Property filter/sort failed',
      finalResponse: 'I apologize, but I encountered an error filtering/sorting properties. Please try again.',
    };
  }
}
