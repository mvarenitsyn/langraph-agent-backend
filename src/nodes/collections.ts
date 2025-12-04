import { AIMessage, HumanMessage, ToolMessage, SystemMessage } from "@langchain/core/messages";
import { AgentStateType } from "../types/state.js";
import { globalToolsRegistry } from "../tools/registry.js";
import { createToolCallingModel, createResponseModel } from "../models/openai.js";
import { sharedPublisher } from "../pubsub/shared.js";
import { getPlatformContext, shouldPublishUIEvents } from "../utils/platformContext.js";
import { buildFormattingInstructions, adaptMarkdown, truncateResponse } from "../utils/formatters.js";

/**
 * Collections Node - Mini Agent with Tool Loop
 *
 * This node is a specialized mini-agent that manages property collections:
 * 1. collection_create - Create new collection
 * 2. collection_list - List user's collections
 * 3. collection_get - Get collection with properties
 * 4. collection_add_property - Add property to collection
 * 5. collection_share - Share collection and get link
 *
 * Flow:
 * - Uses LLM with collection tools bound
 * - Can call tools in a loop for complex operations
 * - Generates final response after tools complete
 */
export async function collectionsNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.log('\n[Collections] Starting collections agent...');

  // Emit progress: Processing collection operation
  await sharedPublisher.publishProgressUpdate({
    sessionId: state.metadata?.sessionId || '',
    userId: state.metadata?.userId,
    correlationId: state.metadata?.correlationId,
    status: 'Processing collection operation...',
  });

  const userContext = state.userContext || { isAuthenticated: false };
  const userName = userContext.fullName || 'there';
  const firstName = userName.split(' ')[0];
  const isAuthenticated = userContext.isAuthenticated || false;

  // Resolve platform context
  const platformContext = getPlatformContext(state);
  console.log(`[Collections] Platform: ${platformContext.platform} (supportsRichUI: ${platformContext.capabilities.supportsRichUI})`);

  if (isAuthenticated && userContext.userId) {
    console.log(`[Collections] User: ${userName}`);
    console.log(`  - Collections: ${userContext.collectionsCount || 0}`);
  } else {
    console.warn('[Collections] ⚠️ User not authenticated - collections require authentication');
  }

  try {
    // Get collection tools
    const collectionCreateTool = globalToolsRegistry.getTool('collection_create');
    const collectionListTool = globalToolsRegistry.getTool('collection_list');
    const collectionGetTool = globalToolsRegistry.getTool('collection_get');
    const collectionAddPropertyTool = globalToolsRegistry.getTool('collection_add_property');
    const collectionShareTool = globalToolsRegistry.getTool('collection_share');

    if (!collectionCreateTool || !collectionListTool || !collectionGetTool || !collectionAddPropertyTool || !collectionShareTool) {
      const missing = [];
      if (!collectionCreateTool) missing.push('collection_create');
      if (!collectionListTool) missing.push('collection_list');
      if (!collectionGetTool) missing.push('collection_get');
      if (!collectionAddPropertyTool) missing.push('collection_add_property');
      if (!collectionShareTool) missing.push('collection_share');
      throw new Error(`Required collection tools not found: ${missing.join(', ')}`);
    }

    const tools = [
      collectionCreateTool,
      collectionListTool,
      collectionGetTool,
      collectionAddPropertyTool,
      collectionShareTool,
    ];

    console.log(`[Collections] ✓ Registered ${tools.length} tools: ${tools.map(t => t.name).join(', ')}`);

    // Create model with tools bound
    const toolModel = createToolCallingModel();
    const modelWithTools = toolModel.bindTools(tools);

    console.log('[Collections] ✓ Tools bound to model successfully');

    // Build rich system prompt with user context
    let systemPrompt = '';

    if (isAuthenticated) {
      systemPrompt = `You are RealVista, a collections specialist helping ${userName} organize their property collections in South Florida.`;

      // Add user's collections context
      if (userContext.collectionsCount && userContext.collectionsCount > 0) {
        systemPrompt += `\n\n**${firstName}'s Collections:** ${userContext.collectionsCount} saved collections`;
      }
    } else {
      systemPrompt = `You are RealVista, a collections specialist for South Florida real estate.

**⚠️ AUTHENTICATION REQUIRED**
Collections require user authentication. All collection tools will fail unless the user is logged in.`;
    }

    const instructions = `
Your job: Use the available tools to help the user manage their property collections.

**Available Tools:**

1. **collection_create** - Create a new property collection
   - Parameters: title (required), description (optional), properties (optional array of listingKeys)
   - Use when: User wants to create a new collection

2. **collection_list** - List user's saved collections
   - Parameters: limit (optional), offset (optional)
   - Use when: User asks to see their collections

3. **collection_get** - Get collection details with properties
   - Parameters: collectionId (required)
   - Use when: User wants to see a specific collection's properties

4. **collection_add_property** - Add a property to a collection
   - Parameters: collectionId (required), listingKey (required)
   - Use when: User wants to add/save a property to a collection

5. **collection_share** - Share a collection and get shareable link
   - Parameters: collectionId (required)
   - Use when: User wants to share a collection with others

**Tool Execution Strategy:**

You can call tools in ANY ORDER based on the user's query. Common patterns:

**Single tool**:
- "create a collection called Favorites" → collection_create
- "show my collections" → collection_list

**Sequential chain**:
- "add this property to my Favorites" → collection_list (to find Favorites) → collection_add_property
- "share my Miami collection" → collection_list (to find Miami) → collection_share

**Multiple iterations**:
- "create a collection and add these properties" →
  collection_create → collection_add_property (for each property)

**Critical Rules:**
1. **ALWAYS USE TOOLS** - Don't just respond with text. Execute the appropriate tools.
2. For adding properties, you need the collectionId - use collection_list first if needed
3. All tools require authentication (userId) - they will fail if user is not logged in
4. Call tools as many times as needed to fully answer the user's query
5. Provide clear feedback about what was done
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
    const maxLoops = 3; // Allow multiple tool calls

    // Tool execution loop
    while (loopCount < maxLoops) {
      console.log(`[Collections] Tool loop iteration ${loopCount + 1}/${maxLoops}`);

      const response = await modelWithTools.invoke(currentMessages);

      // Check if tools were called
      if (response.tool_calls && response.tool_calls.length > 0) {
        console.log(`[Collections] LLM requested ${response.tool_calls.length} tool(s): ${response.tool_calls.map(tc => tc.name).join(', ')}`);

        // Add AI message with tool calls to history
        currentMessages.push(response);

        // Execute each tool call
        for (const toolCall of response.tool_calls) {
          const tool = tools.find(t => t.name === toolCall.name);
          if (!tool) {
            console.error(`[Collections] Tool ${toolCall.name} not found`);
            continue;
          }

          console.log(`[Collections] Executing ${toolCall.name} with args:`, toolCall.args);

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
        console.log('[Collections] No more tool calls - proceeding to response generation');
        break;
      }
    }

    if (loopCount >= maxLoops) {
      console.warn('[Collections] Max tool loop iterations reached');
    }

    console.log('[Collections] ✓ Tool execution completed, generating final response...');

    // Generate final response using a separate model
    const responseModel = createResponseModel();

    const responseInstructions = `
**Your job:** Create a concise, helpful response based on the collection operation results.

**Response Style:**
${isAuthenticated
        ? `- Address the user by their first name: ${firstName}
- Maintain a personal, conversational tone`
        : `- Use a friendly, professional tone`}
- Be concise and direct
- Use bullet points for key information
- Summarize what was done
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

    console.log('[Collections] ✓ Response generated');

    // Adapt response for non-web platforms
    if (platformContext.platform !== 'web') {
      finalResponse = adaptMarkdown(finalResponse, platformContext);
      finalResponse = truncateResponse(finalResponse, platformContext);
      console.log(`[Collections] Response adapted for ${platformContext.platform} (${finalResponse.length} chars)`);
    }

    return {
      finalResponse,
      messages: [...toolMessages, new AIMessage({ content: finalResponse })],
      toolResults,
      platformContext,
    };
  } catch (error) {
    console.error('[Collections] Error:', error);
    return {
      error: error instanceof Error ? error.message : 'Collections operation failed',
      finalResponse: 'I apologize, but I encountered an error with the collection operation. Please try again.',
    };
  }
}
