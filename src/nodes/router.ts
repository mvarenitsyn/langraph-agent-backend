import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { AgentStateType } from "../types/state.js";
import { createToolCallingModel } from "../models/openai.js";
import { globalToolsRegistry } from "../tools/registry.js";
import { getUserContextById } from "../utils/userContext.js";

/**
 * Router Node - First step in RRR pattern
 *
 * Routes the user query to appropriate tools and executes them.
 * Binds all registered tools to the LLM for intelligent tool selection.
 */

/**
 * Agent Node - Calls LLM with tools to decide next action
 *
 * This node replaces the old "router" that also executed tools.
 * Now it ONLY calls the LLM and returns the response (with tool_calls if needed).
 * Tool execution is delegated to the separate "tools" node.
 */
export async function routerNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.log(`\n[Agent] Processing message: "${state.message}"`);

  console.log('[Router] ====== DEBUG: State Received ======');
  console.log('[Router] state.metadata exists?', !!state.metadata);
  console.log('[Router] state.metadata:', JSON.stringify(state.metadata, null, 2));
  console.log('[Router] state.userId:', state.metadata?.userId);

  // Fetch user context from database by userId
  const userId = state.metadata?.userId || state.userId;
  console.log('[Router] ====== DEBUG: Fetching UserContext from Database ======');
  console.log('[Router] userId:', userId);

  const userContext = await getUserContextById(userId);
  const userName = userContext.fullName || 'there';
  const isAuthenticated = userContext.isAuthenticated || false;

  console.log('[Router] ====== DEBUG: UserContext Fetched from Database ======');
  console.log('[Router] userContext:', JSON.stringify(userContext, null, 2));
  console.log(`[Router] User: ${userName} (authenticated=${isAuthenticated})`);

  // Store userContext in state for persistence across turns
  const updatedUserContext = userContext;
  console.log('[Router] Updated userContext for persistence:', JSON.stringify(updatedUserContext, null, 2));

  try {
    // Get all registered tools
    const tools = globalToolsRegistry.getAllTools();
    console.log(`[Agent] Available tools: ${globalToolsRegistry.getToolNames().join(', ')}`);

    // Create model with tools bound
    const model = createToolCallingModel();
    const modelWithTools = model.bindTools(tools);

    // Build messages array including conversation history
    // Personalize system prompt based on authentication status
    const systemPrompt = isAuthenticated
      ? `You are RealVista, an intelligent AI assistant and real estate expert helping ${userName} find properties in South Florida.`
      : `You are RealVista, an intelligent AI assistant and real estate expert in South Florida. The user is browsing as a guest.`;

    // Check if this is a retry attempt and inject recovery strategy
    const currentRetryCount = state.retryCount || 0;
    const recoveryStrategy = state.metadata?.recoveryStrategy;
    const issueAnalysis = state.metadata?.issueAnalysis;
    const previousOdataFilter = state.metadata?.previousOdataFilter;
    const shouldRetry = state.metadata?.shouldRetry;

    // CRITICAL FIX: Only inject retry guidance when shouldRetry flag is TRUE
    // This flag is set by retry node and cleared after first router invocation
    const shouldInjectRetryGuidance = shouldRetry && currentRetryCount > 0 && recoveryStrategy;

    let retryGuidance = '';
    if (shouldInjectRetryGuidance) {
      retryGuidance = `

🔄 **RETRY ATTEMPT ${currentRetryCount}** - Previous attempt had issues:
**What went wrong:** ${issueAnalysis || 'Quality issues detected'}
**How to fix it:** ${recoveryStrategy}

${previousOdataFilter ? `**Previous OData Filter:** ${previousOdataFilter}

**IMPORTANT - How to Modify OData Filter for Retry:**
You MUST modify the previous OData filter according to the recovery strategy above, then call property_search with the modified filter using the "odataFilter" parameter.

Example modifications:
- To expand statuses: Change "(StandardStatus eq 'Active')" to "(StandardStatus eq 'Active' or StandardStatus eq 'Pending' or StandardStatus eq 'Sold' or StandardStatus eq 'Closed')"
- To drop unit number: Remove "and UnitNumber eq '2309'" from the filter
- To drop street direction: Change "StreetDirPrefix eq 'W'" to removing that entire clause
- To drop street number: Remove "and StreetNumber eq '1000'" from the filter

Call property_search like this:
{
  "query": "original user query here",
  "odataFilter": "your modified OData filter string here"
}

This bypasses the mapping layer and uses your modified filter directly.` : ''}

Please apply this guidance when selecting tools.`;
      console.log(`[Agent] 🔄 Retry #${currentRetryCount} with recovery strategy: ${recoveryStrategy}`);
      if (previousOdataFilter) {
        console.log(`[Agent] 📋 Previous OData filter available for modification: ${previousOdataFilter}`);
      }
    }

    const messages = [
      new SystemMessage({
        content: `${systemPrompt}${retryGuidance}
Your job is to analyze user queries and select the most appropriate tools or general knowledge to answer user's question, or perform a task.
Use only verified grounded data, do not come up with something you don't know or now sure about.

**Tool Selection Guidelines:**
- Only use tools to answer queries related to real estate in US market

**Use Perplexity tools when:**
- Query requires real-time data search, answer sensitive questions that require verification, or search for solutions if you don't know the answer
- Gather information about trends, location real-time information, events
- Property Search tool doesn't give results and you need to clarify name of the location, or meaning of real estate term, local terms, slang

**Use Address Validation Tool (validate_address) when:**
- User provides a specific address for property search
- RECOMMENDED: Call this tool FIRST before property_search to verify address exists and get standardized format
- Helps catch typos, formatting issues, or non-existent addresses early
- Returns standardized address components and geocoding
- Provides confidence level (High/Medium/Low) to guide next steps
- Not required but highly recommended for accuracy
- Example: User asks "Find 1000 W Island Blvd Apt 2309" → validate_address first, then property_search

**Use Trestle Metadata Explorer Tool (trestle_metadata_explorer) when:**
- **CRITICAL: ALWAYS use BEFORE constructing or modifying OData filters on retry attempts**
- **REQUIRED for retry attempts**: Validate enum values before including them in OData filters
- property_search returns 400/401 validation errors (unknown field, invalid enum value)
- User queries mention uncommon features (wine cellar, smart home, ocean view, architectural styles)
- Zero-result searches that need filter value adjustments
- Recovery strategy instructs you to validate field names or enum values
- **Common validation tasks**:
  * Validate StandardStatus enum: helpers.getEnum('Cotality.DataStandard.RESO.DD.Enums.StandardStatus').values.map(v => v.value)
  * Validate PropertySubType: helpers.getEnum('Cotality.DataStandard.RESO.DD.Enums.PropertySubType').values
  * Search for field names: helpers.searchFields({resourceName: 'Property', filters: {nameContains: 'keyword'}})
  * Find enum by pattern: Object.keys(metadata.enums).filter(k => k.includes('Status'))
- **IMPORTANT**: Returns metadata in ~1-5ms, safe and fast to call during retry attempts
- **IMPORTANT**: Use exact CamelCase enum values from metadata (e.g., 'ActiveUnderContract' NOT 'Active Under Contract')
- Use JavaScript expressions (NO 'return' statement needed)

**Use Property Search as a first tool when:**
- User asks about properties, homes, condos, apartments, real estate listings
- ALWAYS call this tool FIRST for any property-related query - don't ask clarifying questions
- Before passing the user's query, normalize and standardize it for accurate property search.
- Convert common phrases, area names, building names, community names, and slang into reliable geographic terms (such as zip codes, city names, street names, or street numbers).
- Whenever possible, replace vague terms or nicknames with official place names or geographic identifiers.
- Avoid using address suffixes and street directions (e.g., 'NW', 'Street', 'Ave', 'Blvd') unless absolutely necessary.
- Focus on extracting and using the most accurate and standard location information from the user's query.
- This is your most reliable source of MLS data (active, pending, closed listings)
- The tool returns:
  * Total count of matching properties
  * Search token for viewing results on interactive map
  * Summary and metadata about the search
  * OData filter string (save this for potential retries with odataFilter parameter)
  * NO individual property details (use searchToken to view on map)

**Important Guidelines:**
- Do not mention or recommend any external sources of real estate information
- Use available tools (perplexity_search) to find information when property_search fails
- Provide direct answers based on tool results or acknowledge limitations

**Best Practices:**
- For property searches: CALL THE TOOL IMMEDIATELY with user's query - no clarification needed
- Only ask clarifying questions AFTER the tool returns results, if needed
- If Property Search returns a searchToken, inform the user they can view results on the interactive map
- Only use multiple tools if you have multi-step task or it's required to provide minimum information
- Don't use tools for meta-questions about the assistant itself (e.g., "what tools do you have?")
- If user prefers to speak another language, continue conversation in that language
- Conversational responses should not exceed 100 characters
`,
      }),
      // Include conversation history from state
      ...(state.messages || []),
      // Add current user message
      new HumanMessage({
        content: state.message,
      }),
    ];

    // Invoke model
    console.log('[Agent] Calling LLM with tools...');
    const response = await modelWithTools.invoke(messages);

    // Check if tools were called in THIS response
    if (response.tool_calls && response.tool_calls.length > 0) {
      console.log(`[Agent] LLM requested ${response.tool_calls.length} tool(s): ${response.tool_calls.map(tc => tc.name).join(', ')}`);

      // Add user message and AI response to messages array
      // The tools node will execute the tools and add ToolMessages
      const userMessage = new HumanMessage({ content: state.message });
      return {
        messages: [userMessage, response],
        userContext: updatedUserContext,
        metadata: {
          ...state.metadata,
          usedTools: true, // Mark that tools were requested
          // Don't clear shouldRetry here - let Retry node control it
        },
      };
    } else {
      // No NEW tool calls - check if tools were used EARLIER in this turn
      // by looking for ToolMessages in the message history
      const hasToolMessages = state.messages?.some(msg => msg._getType() === 'tool') || false;
      const previouslyUsedTools = state.metadata?.usedTools || false;
      const toolsWereUsed = hasToolMessages || previouslyUsedTools;

      if (toolsWereUsed) {
        // Tools were used earlier, agent is synthesizing results

        // ============================================================
        // OPTIMIZATION: Fast-path for successful simple searches
        // ============================================================
        // Check if the last tool call was property_search and if it succeeded
        const toolMessages = state.messages?.filter(msg => msg._getType() === 'tool') || [];
        const lastToolMessage = toolMessages.slice(-1)[0];

        // Find the most recent tool call from AIMessages
        const aiMessagesWithTools = state.messages?.filter(
          msg => msg._getType() === 'ai' && (msg as AIMessage).tool_calls?.length > 0
        ) || [];
        const lastToolCall = (aiMessagesWithTools.slice(-1)[0] as AIMessage)?.tool_calls?.[0];

        const wasPropertySearch = lastToolCall?.name === 'property_search';

        let searchSuccessful = false;
        if (wasPropertySearch && lastToolMessage) {
          try {
            // Parse tool result from ToolMessage content
            const toolContent = lastToolMessage.content;
            const parsedResult = typeof toolContent === 'string'
              ? JSON.parse(toolContent)
              : toolContent;

            // Success criteria: tool succeeded, has results, and has searchToken
            searchSuccessful = parsedResult?.success === true &&
              parsedResult?.totalCount > 0 &&
              parsedResult?.searchToken != null;

            if (searchSuccessful) {
              console.log(`[Agent] ✅ Property search successful (${parsedResult.totalCount} properties) - FAST-PATH: Skipping RRR`);
              console.log(`[Agent]    SearchToken: ${parsedResult.searchToken}`);
            }
          } catch (parseError) {
            console.warn('[Agent] Failed to parse tool result for fast-path check:', parseError);
          }
        }

        // Fast-path: Skip RRR for successful property searches (BUT NOT during retries)
        // CRITICAL: Disable fast-path during retries to ensure reflection happens and validates retry success
        const isRetryAttempt = currentRetryCount > 0;
        if (wasPropertySearch && searchSuccessful && !isRetryAttempt) {
          const conversationalResponse = response.content as string;
          const userMessage = new HumanMessage({ content: state.message });

          return {
            messages: [userMessage, response],
            userContext: updatedUserContext,
            metadata: {
              ...state.metadata,
              usedTools: true,
              skipReflection: true, // ✅ CRITICAL: Skip reflection, go to generate_response
              fastPath: 'simple-search-success',
              optimizationApplied: true,
            },
          };
        }

        // Default: Proceed to reflection for all other cases
        console.log('[Agent] Synthesizing tool results into response - will proceed to reflection');

        // Extract tool results from ToolMessages for Reflect node
        const toolResults: Record<string, any> = {};
        const allToolMessages = state.messages?.filter(msg => msg._getType() === 'tool') || [];
        const allAIMessagesWithTools = state.messages?.filter(
          msg => msg._getType() === 'ai' && (msg as AIMessage).tool_calls?.length > 0
        ) || [];

        // Match each ToolMessage with its corresponding tool_call to get tool names
        for (let i = 0; i < allToolMessages.length; i++) {
          const toolMsg = allToolMessages[i];
          const aiMsg = allAIMessagesWithTools[i] as AIMessage;
          if (aiMsg && aiMsg.tool_calls && aiMsg.tool_calls.length > 0) {
            const toolName = aiMsg.tool_calls[0].name;
            const toolContent = toolMsg.content;
            toolResults[toolName] = typeof toolContent === 'string' ? toolContent : JSON.stringify(toolContent);
          }
        }

        // CRITICAL FIX: NEVER add synthesis response to messages when tools are used
        // Only generate_response should create the final user-facing response
        // Reflect can analyze raw tool results without needing synthesized response
        console.log(`[Agent] Tools used - skipping synthesis response, passing tool results directly to Reflect`);

        return {
          toolResults, // ✅ CRITICAL: Pass tool results to Reflect node
          metadata: {
            ...state.metadata,
            usedTools: true, // Keep usedTools=true so reflect is triggered
            // Do NOT set skipRRR here - we want reflection on tool-based responses
          },
        };
      } else {
        // Truly conversational message (no tools at all)
        console.log('[Agent] No tools called - conversational message, skipping RRR pattern');

        const conversationalResponse = response.content as string;
        const userMessage = new HumanMessage({ content: state.message });

        return {
          messages: [userMessage, response],
          finalResponse: conversationalResponse,
          userContext: updatedUserContext,
          metadata: {
            ...state.metadata,
            usedTools: false,
            skipRRR: true, // Skip RRR for pure conversational messages
          },
        };
      }
    }
  } catch (error) {
    console.error('[Agent] ✗ Error:', error);
    return {
      error: error instanceof Error ? error.message : 'Agent node failed',
    };
  }
}
