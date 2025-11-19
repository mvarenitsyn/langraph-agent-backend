import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { AgentStateType } from "../types/state.js";
import { createToolCallingModel } from "../models/openai.js";
import { globalToolsRegistry } from "../tools/registry.js";
import { getUserContextById } from "../utils/userContext.js";

/**
 * SIMPLIFIED Agent Node - ReAct Pattern Only
 *
 * This node has ONE job: Decide which tools to call (if any).
 * It does NOT:
 * - Generate conversational responses
 * - Synthesize tool results
 * - Set metadata flags
 * - Handle retries or recovery
 *
 * The generate_response node is the ONLY node that creates final user-facing text.
 */
export async function routerNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.log(`\n[Agent] Processing message: "${state.message}"`);

  // Fetch user context from database
  const userId = state.metadata?.userId || state.userId;
  const userContext = await getUserContextById(userId);
  const userName = userContext.fullName || 'there';
  const isAuthenticated = userContext.isAuthenticated || false;

  console.log(`[Agent] User: ${userName} (authenticated=${isAuthenticated})`);

  try {
    // Get all registered tools
    const tools = globalToolsRegistry.getAllTools();
    console.log(`[Agent] Available tools: ${globalToolsRegistry.getToolNames().join(', ')}`);

    // Create model with tools bound
    const model = createToolCallingModel();
    const modelWithTools = model.bindTools(tools);

    // Build system prompt - SIMPLIFIED VERSION
    const systemPrompt = isAuthenticated
      ? `You are RealVista, an intelligent AI assistant and real estate expert helping ${userName} find properties in South Florida.`
      : `You are RealVista, an intelligent AI assistant and real estate expert in South Florida. The user is browsing as a guest.`;

    const instructions = `
Your ONLY job is to decide which tools to call to help answer the user's question.

Do NOT generate conversational responses here - just call the appropriate tools.

**Tool Selection Guidelines:**

**Use property_search when:**
- User asks about properties, homes, condos, apartments, real estate listings
- ALWAYS call this tool FIRST for any property-related query
- This is your most reliable source of MLS data (active, pending, closed listings)

**Use perplexity_search when:**
- Query requires real-time information
- Property search doesn't give results and you need to clarify location names or real estate terms

**Use validate_address when:**
- User provides a specific address for property search
- RECOMMENDED: Call this FIRST before property_search to verify address exists

**Use trestle_metadata_explorer when:**
- property_search returns validation errors (unknown field, invalid enum value)
- User queries mention uncommon features (wine cellar, smart home, ocean view)

**Best Practices:**
- For property searches: CALL THE TOOL IMMEDIATELY with user's query
- Don't ask clarifying questions - just call the relevant tool
- If unsure, default to property_search for real estate queries
`;

    const messages = [
      new SystemMessage({
        content: `${systemPrompt}\n${instructions}`,
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

    // Check if tools were called
    if (response.tool_calls && response.tool_calls.length > 0) {
      console.log(`[Agent] LLM requested ${response.tool_calls.length} tool(s): ${response.tool_calls.map(tc => tc.name).join(', ')}`);

      // Return tool calls - graph will route to tools node
      const userMessage = new HumanMessage({ content: state.message });
      return {
        messages: [userMessage, response],
        userContext,
      };
    } else {
      // No tool calls - graph will route to generate_response
      console.log('[Agent] No tool calls - routing to generate_response');

      const userMessage = new HumanMessage({ content: state.message });
      return {
        messages: [userMessage, response],
        userContext,
      };
    }
  } catch (error) {
    console.error('[Agent] Error:', error);
    return {
      error: error instanceof Error ? error.message : 'Agent node failed',
    };
  }
}
