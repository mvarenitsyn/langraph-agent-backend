import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { AgentStateType } from "../types/state.js";
import { createResponseModel } from "../models/openai.js";

/**
 * Generate Response Node
 *
 * Final node that synthesizes all tool results and creates a comprehensive
 * response for the user.
 */

export async function generateResponseNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.log('\n[GenerateResponse] Creating final response...');

  try {
    const model = createResponseModel();

    // Build response generation prompt
    const responsePrompt = `
You are RealVista, a helpful real estate assistant specializing in Miami, Florida.

**RESPONSE STYLE: CONCISE & DIRECT**
- Get to the point quickly - avoid lengthy explanations
- Use bullet points and short paragraphs
- Skip obvious statements and filler words
- For property searches: Lead with key numbers (count, price range), then 2-3 bullet highlights
- Next steps: 1-2 clear options max, not a long menu

**User's Original Message:** ${state.message}

**Tool Results Available:**
${JSON.stringify(state.toolResults, null, 2)}

**Reflection Analysis:**
${state.reflection || 'No reflection available'}

**Instructions:**
1. Start with the core answer (numbers, findings, or direct response)
2. Add 2-4 key highlights or bullet points (not exhaustive lists)
3. Mention any limitations briefly (1 sentence if needed)
4. End with 1-2 actionable next steps
5. Be conversational but concise - quality over quantity

**Structure for Property Searches:**
- First line: "Found X properties [with key criteria]"
- 2-3 bullet points: typical price range, property types, locations/features
- Brief note if listing details not included
- 1-2 next step suggestions (get details, schedule showings, etc.)

Generate a focused, concise response. Aim for clarity and brevity.
`;

    const response = await model.invoke([
      new HumanMessage({ content: responsePrompt }),
    ]);

    const finalResponse = response.content as string;
    console.log('[GenerateResponse] ✓ Response generated');

    // Add final AI response to messages array for LangGraph Studio
    const aiMessage = new AIMessage({ content: finalResponse });
    return {
      finalResponse,
      messages: [aiMessage],
    };
  } catch (error) {
    console.error('[GenerateResponse] ✗ Error:', error);
    return {
      error: error instanceof Error ? error.message : 'Response generation failed',
      finalResponse: 'I apologize, but I encountered an error generating a response. Please try again.',
    };
  }
}
