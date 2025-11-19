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

**Response Style:**
${isAuthenticated
  ? `- Address the user by their first name: ${firstName}
- Maintain a personal, conversational tone`
  : `- Use a friendly, professional tone
- Avoid assuming the user has an account`}
- Be concise and direct - get to the point quickly
- Use bullet points for key information
- For property searches: Lead with key numbers (count, price range), then highlights
- End with 1-2 clear next step suggestions

**Structure for Property Searches:**
- First line: "Found X properties [with key criteria]"
- 2-3 bullet points: price range, property types, key features
- Brief note if you can't provide full details
- 1-2 next step suggestions (view on map, refine search, etc.)

Generate a focused, helpful response based on the conversation history below.
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
