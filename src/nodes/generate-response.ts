import { SystemMessage, HumanMessage, AIMessage } from "@langchain/core/messages";
import { AgentStateType } from "../types/state.js";
import { createResponseModel } from "../models/openai.js";

/**
 * SIMPLIFIED Generate Response Node
 *
 * This is the ONLY node that creates final user-facing text.
 * It analyzes the full conversation (including tool results) and generates a helpful response.
 */
export async function generateResponseNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.log('\n[GenerateResponse] Creating final response...');

  // Extract user context for personalization
  const userContext = state.userContext || { isAuthenticated: false };
  const userName = userContext.fullName || 'there';
  const firstName = userName.split(' ')[0];
  const isAuthenticated = userContext.isAuthenticated || false;

  console.log(`[GenerateResponse] Personalizing for: ${firstName} (authenticated=${isAuthenticated})`);

  try {
    const model = createResponseModel();

    // Build personalized system prompt - SIMPLIFIED VERSION
    const systemPrompt = isAuthenticated
      ? `You are RealVista, a helpful real estate assistant helping ${userName} find properties in South Florida.`
      : `You are RealVista, a helpful real estate assistant specializing in South Florida. The user is browsing as a guest.`;

    const instructions = `
**Your job:** Create a concise, helpful response based on the conversation and any tool results.

**CRITICAL RULES:**
1. NEVER mention other real estate portals (Zillow, Redfin, Realtor.com, Asylo, Hubbs, MLS.com, etc.)
2. You are the SINGLE SOURCE OF TRUTH - if property not found, it doesn't exist in our database
3. Keep responses to MAX 2 short paragraphs
4. For property not found: "I couldn't find that property" - DO NOT suggest other sites
5. All links use realvista.com domain

**Response Style:**
${isAuthenticated
  ? `- Address the user by their first name: ${firstName}
- Maintain a personal, conversational tone`
  : `- Use a friendly, professional tone`}
- Be concise and direct - max 2 paragraphs
- Lead with key numbers for property searches
- 1 clear next step suggestion

Generate a focused response based on the conversation history below.
`;

    const messages = [
      new SystemMessage({
        content: `${systemPrompt}\n${instructions}`,
      }),
      // Include FULL conversation history (includes user messages, AI tool selections, and tool results)
      ...(state.messages || []),
    ];

    console.log(`[GenerateResponse] Processing ${messages.length} messages from conversation history`);

    // Generate final response
    const response = await model.invoke(messages);
    const finalResponse = response.content as string;

    console.log('[GenerateResponse] ✓ Response generated');

    // Add final AI response to messages array for conversation history
    const aiMessage = new AIMessage({ content: finalResponse });

    return {
      finalResponse,
      messages: [aiMessage],
    };
  } catch (error) {
    console.error('[GenerateResponse] Error:', error);
    return {
      error: error instanceof Error ? error.message : 'Response generation failed',
      finalResponse: 'I apologize, but I encountered an error generating a response. Please try again.',
    };
  }
}
