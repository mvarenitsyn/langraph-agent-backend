import { AIMessage, HumanMessage, ToolMessage, SystemMessage } from "@langchain/core/messages";
import { AgentStateType } from "../types/state.js";
import { globalToolsRegistry } from "../tools/registry.js";
import { createToolCallingModel, createResponseModel } from "../models/openai.js";
import { getPlatformContext } from "../utils/platformContext.js";
import { buildFormattingInstructions, adaptMarkdown, truncateResponse } from "../utils/formatters.js";

/**
 * Perplexity Search Node - Mini Agent with Tool Loop
 *
 * This node is a specialized mini-agent that can use perplexity tools:
 * 1. perplexity_search - General web search
 * 2. perplexity_real_estate_research - Real estate market research
 *
 * Flow:
 * - Uses LLM with tools bound to decide which tools to call
 * - Can call tools in a loop for comprehensive research
 * - Generates final response after tools complete
 */
export async function perplexitySearchNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.log('\n[PerplexitySearch] Starting perplexity search agent...');

  const userContext = state.userContext || { isAuthenticated: false };
  const userName = userContext.fullName || 'there';
  const firstName = userName.split(' ')[0];
  const isAuthenticated = userContext.isAuthenticated || false;

  // Resolve platform context
  const platformContext = getPlatformContext(state);
  console.log(`[PerplexitySearch] Platform: ${platformContext.platform} (supportsRichUI: ${platformContext.capabilities.supportsRichUI})`);

  if (isAuthenticated && userContext.userId) {
    console.log(`[PerplexitySearch] User: ${userName}`);
    console.log(`  - Listings: ${userContext.linkedListingsCount || 0}`);
    console.log(`  - Collections: ${userContext.collectionsCount || 0}`);
  }

  try {
    // Get perplexity tools
    const perplexitySearchTool = globalToolsRegistry.getTool('perplexity_search');
    const perplexityResearchTool = globalToolsRegistry.getTool('perplexity_real_estate_research');

    if (!perplexitySearchTool) {
      throw new Error('perplexity_search tool not found');
    }

    const tools = [perplexitySearchTool];
    if (perplexityResearchTool) {
      tools.push(perplexityResearchTool);
      console.log('[PerplexitySearch] Tools available: perplexity_search, perplexity_real_estate_research');
    } else {
      console.log('[PerplexitySearch] Tools available: perplexity_search only');
    }

    // Create model with tools bound
    const toolModel = createToolCallingModel();
    const modelWithTools = toolModel.bindTools(tools);

    // Build rich system prompt with user context
    let systemPrompt = '';

    if (isAuthenticated) {
      systemPrompt = `You are RealVista, a research specialist helping ${userName} with real estate information and market insights.`;

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
      systemPrompt = `You are RealVista, a research specialist for real estate information and market insights.`;
    }

    const instructions = `
Your job: Use available tools to research and answer the user's query.

**Available Tools:**
1. **perplexity_search** - General web search for current information
2. **perplexity_real_estate_research** (if available) - Real estate market research and trends

**Strategy:**
- For general questions: Use perplexity_search
- For market trends, neighborhood info, real estate insights: Use perplexity_real_estate_research
- Call tools as needed to provide comprehensive answers

After tools complete, I'll generate the final response for the user.
`;

    // Include conversation history to understand context and provide personalized research
    // This enables contextual research based on previous queries and user preferences
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
    const maxLoops = 3; // Prevent infinite loops

    // Tool execution loop
    while (loopCount < maxLoops) {
      console.log(`[PerplexitySearch] Tool loop iteration ${loopCount + 1}/${maxLoops}`);

      const response = await modelWithTools.invoke(currentMessages);

      // Check if tools were called
      if (response.tool_calls && response.tool_calls.length > 0) {
        console.log(`[PerplexitySearch] LLM requested ${response.tool_calls.length} tool(s): ${response.tool_calls.map(tc => tc.name).join(', ')}`);

        // Add AI message with tool calls to history
        currentMessages.push(response);

        // Execute each tool call
        for (const toolCall of response.tool_calls) {
          const tool = tools.find(t => t.name === toolCall.name);
          if (!tool) {
            console.error(`[PerplexitySearch] Tool ${toolCall.name} not found`);
            continue;
          }

          console.log(`[PerplexitySearch] Executing ${toolCall.name} with args:`, toolCall.args);
          const result = await tool.invoke(toolCall.args);
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
        console.log('[PerplexitySearch] No more tool calls - proceeding to response generation');
        break;
      }
    }

    if (loopCount >= maxLoops) {
      console.warn('[PerplexitySearch] Max tool loop iterations reached');
    }

    console.log('[PerplexitySearch] ✓ Tool execution completed, generating final response...');

    // Generate final response using a separate model
    const responseModel = createResponseModel();

    // Add platform-specific formatting instructions
    const platformFormattingInstructions = buildFormattingInstructions(platformContext);

    const responseInstructions = `
**Your job:** Create a concise, helpful response based on the research results.

**Response Style:**
${isAuthenticated
  ? `- Address the user by their first name: ${firstName}
- Maintain a personal, conversational tone`
  : `- Use a friendly, professional tone`}
- Be concise and direct
- Use bullet points for key information
- Cite sources when available
- End with 1-2 clear next step suggestions

${platformFormattingInstructions}

Generate a focused response based on the research results below.
`;

    // Clean message history for response generation
    // Include user query + COMPLETE tool loop conversation (AIMessages with tool_calls + ToolMessages)
    // Extract tool loop conversation from currentMessages (skip initial messages)
    const toolLoopConversation = currentMessages.slice(toolLoopStartIndex); // Skip initial messages

    const responseMessages = [
      new SystemMessage({ content: `${systemPrompt}\n${responseInstructions}` }),
      latestUserMessage,        // User's original query
      ...toolLoopConversation,  // Complete tool loop: AIMessages + ToolMessages
    ];

    const finalResponseMsg = await responseModel.invoke(responseMessages);
    let finalResponse = finalResponseMsg.content as string;

    console.log('[PerplexitySearch] ✓ Response generated');

    // Adapt response for non-web platforms
    if (platformContext.platform !== 'web') {
      finalResponse = adaptMarkdown(finalResponse, platformContext);
      finalResponse = truncateResponse(finalResponse, platformContext);
      console.log(`[PerplexitySearch] Response adapted for ${platformContext.platform} (${finalResponse.length} chars)`);
    }

    return {
      finalResponse,
      messages: [...toolMessages, new AIMessage({ content: finalResponse })],
      toolResults,
      platformContext,
    };
  } catch (error) {
    console.error('[PerplexitySearch] Error:', error);
    return {
      error: error instanceof Error ? error.message : 'Perplexity search failed',
      finalResponse: 'I apologize, but I encountered an error researching your question. Please try again.',
    };
  }
}
