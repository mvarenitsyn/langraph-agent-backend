import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { AgentStateType } from "../types/state.js";
import { createResponseModel } from "../models/openai.js";
import { uiEventPublisher } from "../pubsub/ui-event-publisher.js";
import { sharedPublisher } from "../pubsub/shared.js";
import { getPlatformContext, shouldPublishUIEvents } from "../utils/platformContext.js";
import { buildFormattingInstructions, adaptMarkdown, truncateResponse } from "../utils/formatters.js";

/**
 * Search Response Generator Node
 *
 * Generates user-friendly response from search results and publishes UI events.
 *
 * This node:
 * 1. Reads searchId, summary, and totalCount from toolResults
 * 2. Generates conversational response using LLM
 * 3. Publishes UI render events for web platforms
 * 4. Adapts response for non-web platforms (WhatsApp, SMS, etc.)
 */
export async function searchResponseGeneratorNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.log('\n[SearchResponseGenerator] Generating final response...');

  // Publish progress update
  const { sessionId, userId: metaUserId, correlationId } = state.metadata || {};
  if (sessionId) {
    await sharedPublisher.publishProgressUpdate({
      sessionId,
      userId: metaUserId,
      correlationId,
      status: 'Generating response...'
    });
  }

  const userContext = state.userContext || { isAuthenticated: false };
  const userName = userContext.fullName || 'there';
  const firstName = userName.split(' ')[0];
  const isAuthenticated = userContext.isAuthenticated || false;

  // Resolve platform context
  const platformContext = getPlatformContext(state);
  console.log(`[SearchResponseGenerator] Platform: ${platformContext.platform} (supportsRichUI: ${platformContext.capabilities.supportsRichUI})`);

  // Extract search results from toolResults
  const searchId = state.toolResults?.searchId as string | undefined;
  const summary = state.toolResults?.summary as any | undefined;
  const totalCount = (summary?.total || state.metadata?.totalCount || 0) as number;

  if (!searchId) {
    console.warn('[SearchResponseGenerator] No searchId found in toolResults');
    return {
      finalResponse: 'Search completed, but search ID was not generated. Please try again.',
    };
  }

  console.log(`[SearchResponseGenerator] Generating response for searchId: ${searchId}, totalCount: ${totalCount}`);

  try {
    // Generate final response using a separate model
    const responseModel = createResponseModel();

    // Build system prompt
    let systemPrompt = '';
    if (isAuthenticated) {
      systemPrompt = `You are RealVista, a property search specialist helping ${userName} find properties in South Florida.`;

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
      systemPrompt = `You are RealVista, a property search specialist for South Florida real estate.`;
    }

    // Add platform-specific formatting instructions
    const platformFormattingInstructions = buildFormattingInstructions(platformContext);

    const responseInstructions = `
**Your job:** Create a concise, helpful response based on the property search results.

**Response Style:**
${isAuthenticated
        ? `- Address the user by their first name: ${firstName}
- Maintain a personal, conversational tone`
        : `- Use a friendly, professional tone`}
- Be concise and direct
- Use bullet points for key information
- Lead with key numbers (count, price range)
- End with 1-2 clear next step suggestions

${platformFormattingInstructions}

Generate a focused response based on the search summary below.
`;

    // Build search summary text for LLM context
    const summaryText = summary ? `
Search Results Summary:
- Total properties found: ${summary.total}
${summary.duplicatesRemoved > 0 ? `- Duplicates removed: ${summary.duplicatesRemoved}` : ''}
${summary.topCities?.length > 0 ? `- Top cities: ${summary.topCities.join(', ')}` : ''}
${summary.priceRange?.min && summary.priceRange?.max ? `- Price range: $${summary.priceRange.min.toLocaleString()} - $${summary.priceRange.max.toLocaleString()}` : ''}
${summary.bedroomRange?.min && summary.bedroomRange?.max ? `- Bedrooms: ${summary.bedroomRange.min} - ${summary.bedroomRange.max}` : ''}
- Search ID: ${searchId}
` : `Search completed with ${totalCount} properties (searchId: ${searchId})`;

    // Create response generation messages
    const latestUserMessage = new HumanMessage({ content: state.message });

    const responseMessages = [
      new SystemMessage({ content: `${systemPrompt}\n${responseInstructions}` }),
      latestUserMessage,
      new HumanMessage({ content: summaryText }),
    ];

    const responseStart = Date.now();
    const finalResponseMsg = await responseModel.invoke(responseMessages);
    const responseGenerationTime = Date.now() - responseStart;
    console.log(`[SearchResponseGenerator] ⏱️  Response generation time: ${responseGenerationTime}ms`);

    let finalResponse = finalResponseMsg.content as string;

    console.log('[SearchResponseGenerator] ✓ Response generated');

    // Adapt response for non-web platforms
    if (platformContext.platform !== 'web') {
      finalResponse = adaptMarkdown(finalResponse, platformContext);
      finalResponse = truncateResponse(finalResponse, platformContext);
      console.log(`[SearchResponseGenerator] Response adapted for ${platformContext.platform} (${finalResponse.length} chars)`);
    }

    // NOTE: UI render event now published in result_saver node for immediate frontend updates
    // This allows frontend to fetch properties while response is being generated
    // Keeping this comment for clarity - the publish call was moved to result_saver.ts line 115
    console.log('[SearchResponseGenerator] UI event already published by result_saver node');

    return {
      finalResponse,
      messages: [new AIMessage({ content: finalResponse })],
      metadata: {
        ...state.metadata,
        searchId, // Ensure searchId is in metadata
        totalCount,
      },
      platformContext,
    };

  } catch (error) {
    console.error('[SearchResponseGenerator] Error:', error);
    return {
      error: error instanceof Error ? error.message : 'Response generation failed',
      finalResponse: 'I found properties for you, but encountered an error generating the response. Please try again.',
    };
  }
}
