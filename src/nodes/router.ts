import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { AgentStateType } from "../types/state.js";
import { createToolCallingModel } from "../models/openai.js";
import { globalToolsRegistry } from "../tools/registry.js";

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

  try {
    // Get all registered tools
    const tools = globalToolsRegistry.getAllTools();
    console.log(`[Agent] Available tools: ${globalToolsRegistry.getToolNames().join(', ')}`);

    // Create model with tools bound
    const model = createToolCallingModel();
    const modelWithTools = model.bindTools(tools);

    // Build messages array including conversation history
    const messages = [
      new SystemMessage({
        content: `You are RealVista an intelligent AI assistant and real estate expert in South Florida. Your job is to analyze user queries and select the most appropriate tools or general knowledge to answer user's question, or perform a task.
Use only verified grounded data, do not come up with something you don't know or now sure about.

**Tool Selection Guidelines:**
- Only use tools to answer queries related to real estate in US market

**Use Perplexity tools when:**
- Query requires real-time data search, answer sensitive questions that require verification, or search for solutions if you don't know the answer
- Gather information about trends, location real-time information, events
- Property Search tool doesn't give results and you need to clarify name of the location, or meaning of real estate term, local terms, slang

**Use Property Search tool when:**
- User asks about properties, homes, condos, apartments, real estate listings
- ALWAYS call this tool FIRST for any property-related query - don't ask clarifying questions
- Pass the user's query EXACTLY as they wrote it - the tool handles parsing
- This is your most reliable source of MLS data (active, pending, closed listings)
- The tool returns:
  * Total count of matching properties
  * Search token for viewing results on interactive map
  * Summary and metadata about the search
  * NO individual property details (use searchToken to view on map)

**Best Practices:**
- For property searches: CALL THE TOOL IMMEDIATELY with user's query - no clarification needed
- Only ask clarifying questions AFTER the tool returns results, if needed
- If Property Search returns a searchToken, inform the user they can view results on the interactive map
- Only use multiple tools if you have multi-step task or it's required to provide minimum information
- Don't use tools for meta-questions about the assistant itself (e.g., "what tools do you have?")
- If user prefers to speak another language, continue conversation in that language
- Conversational responses should not exceed 200 characters
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
        metadata: {
          ...state.metadata,
          usedTools: true, // Mark that tools were requested
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
        // DO NOT skip RRR - let reflect evaluate the quality
        console.log('[Agent] Synthesizing tool results into response - will proceed to reflection');

        const conversationalResponse = response.content as string;
        const userMessage = new HumanMessage({ content: state.message });

        return {
          messages: [userMessage, response],
          finalResponse: conversationalResponse,
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
