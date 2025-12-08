import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { AgentStateType } from "../types/state.js";
import { createToolCallingModel, createResponseModel, createRouterModel } from "../models/openai.js";
import { globalToolsRegistry } from "../tools/registry.js";
import { getUserContextById } from "../utils/userContext.js";
import { sharedPublisher } from "../pubsub/shared.js";
import { getPlatformContext } from "../utils/platformContext.js";
import { buildFormattingInstructions, adaptMarkdown, truncateResponse } from "../utils/formatters.js";

/**
 * Router Node - LLM-Based Decision Making
 *
 * This node uses LLM to:
 * 1. Decide if property_search tool is needed
 * 2. If yes: call tool (graph routes to property_search node)
 * 3. If no: generate response directly
 */
export async function routerNode(state: AgentStateType): Promise<Partial<AgentStateType>> {
  console.log(`\n[Router] Processing message: "${state.message}"`);

  // Emit progress: Analyzing query
  await sharedPublisher.publishProgressUpdate({
    sessionId: state.metadata?.sessionId || '',
    userId: state.metadata?.userId,
    correlationId: state.metadata?.correlationId,
    status: 'Analyzing query...',
  });

  // 🚨 CRITICAL FIX: Log incoming metadata to debug searchId issue
  console.log('[Router] ====== DEBUG: Incoming State Metadata ======');
  console.log('[Router] state.metadata:', JSON.stringify(state.metadata, null, 2));
  console.log('[Router] state.metadata.searchId:', state.metadata?.searchId || 'NONE');

  // Fetch comprehensive user context from database
  const userId = state.metadata?.userId;
  const userContext = await getUserContextById(userId);
  const userName = userContext.fullName || 'there';
  const firstName = userName.split(' ')[0];
  const isAuthenticated = userContext.isAuthenticated || false;

  console.log(`[Router] User: ${userName} (authenticated=${isAuthenticated})`);
  if (isAuthenticated && userContext.userId) {
    console.log(`[Router] User Profile:`);
    console.log(`  - Listings: ${userContext.linkedListingsCount}`);
    console.log(`  - Collections: ${userContext.collectionsCount}`);
    console.log(`  - CMAs: ${userContext.cmasCount}`);
    console.log(`  - Showings: ${userContext.showingsCount}`);
  }

  // Resolve platform context
  const platformContext = getPlatformContext(state);
  console.log(`[Router] Platform: ${platformContext.platform} (supportsRichUI: ${platformContext.capabilities.supportsRichUI})`);

  try {
    // Create model with streaming DISABLED for router decisions
    // Use createRouterModel() because:
    // - Router outputs include "ROUTE: PROPERTY_SEARCH" directives that are internal signals
    // - These should NOT be streamed to users - they're for graph routing only
    // - Streaming: false prevents routing directives from appearing in chat
    const model = createRouterModel();

    // Build rich system prompt with user context
    let systemPrompt = '';

    if (isAuthenticated) {
      // Authenticated user - inject comprehensive context
      systemPrompt = `You are RealVista, a helpful real estate assistant helping ${userName} with South Florida properties and real estate information.

**User Profile:**
- Name: ${userName}
- Email: ${userContext.email || 'Not provided'}
- License: ${userContext.licenseNumber || 'Not provided'} (${userContext.licenseState || 'N/A'})
- Office: ${userContext.officeName || 'Not provided'}
- Status: ${userContext.status || 'active'}`;

      // Add listings context if available
      if (userContext.linkedListingsCount && userContext.linkedListingsCount > 0) {
        systemPrompt += `

**User's Listings (${userContext.linkedListingsCount} total):**`;
        if (userContext.listings && userContext.listings.length > 0) {
          systemPrompt += `\n${userContext.listings.slice(0, 10).map((listing, idx) =>
            `${idx + 1}. Listing ID: ${listing.listingId} (linked ${new Date(listing.linkedAt).toLocaleDateString()} via ${listing.linkedVia})`
          ).join('\n')}`;
          if (userContext.listings.length > 10) {
            systemPrompt += `\n... and ${userContext.listings.length - 10} more`;
          }
        }
      }

      // Add collections context if available
      if (userContext.collectionsCount && userContext.collectionsCount > 0) {
        systemPrompt += `

**User's Collections (${userContext.collectionsCount} total):**`;
        if (userContext.collections && userContext.collections.length > 0) {
          systemPrompt += `\n${userContext.collections.slice(0, 10).map((collection, idx) =>
            `${idx + 1}. "${collection.title}" - ${collection.propertiesCount} properties (created ${new Date(collection.createdAt).toLocaleDateString()})`
          ).join('\n')}`;
          if (userContext.collections.length > 10) {
            systemPrompt += `\n... and ${userContext.collections.length - 10} more`;
          }
        }
      }

      // Add CMAs context if available
      if (userContext.cmasCount && userContext.cmasCount > 0) {
        systemPrompt += `

**User's CMA Reports (${userContext.cmasCount} total):**`;
        if (userContext.cmas && userContext.cmas.length > 0) {
          systemPrompt += `\n${userContext.cmas.slice(0, 10).map((cma, idx) =>
            `${idx + 1}. ${cma.propertyAddress} - ${cma.status} (${cma.progressPercentage}% complete)`
          ).join('\n')}`;
          if (userContext.cmas.length > 10) {
            systemPrompt += `\n... and ${userContext.cmas.length - 10} more`;
          }
        }
      }

      // Add showings context if available
      if (userContext.showingsCount && userContext.showingsCount > 0) {
        systemPrompt += `

**User's Showings (${userContext.showingsCount} total):**`;
        if (userContext.showings && userContext.showings.length > 0) {
          systemPrompt += `\n${userContext.showings.slice(0, 10).map((showing, idx) => {
            const scheduledInfo = showing.scheduledAt
              ? `scheduled for ${new Date(showing.scheduledAt).toLocaleString()}`
              : 'not yet scheduled';
            return `${idx + 1}. ${showing.propertyAddress || 'Unknown address'} - ${showing.status} (${scheduledInfo})`;
          }).join('\n')}`;
          if (userContext.showings.length > 10) {
            systemPrompt += `\n... and ${userContext.showings.length - 10} more`;
          }
        }
      }

      systemPrompt += `

When the user asks about "my listings", "my collections", "my CMAs", or "my showings", refer to the data above.`;
    } else {
      // Guest user - simple prompt
      systemPrompt = `You are RealVista, a helpful real estate assistant specializing in South Florida.

**Note:** This user is not authenticated. To access personalized features like saved listings, collections, CMAs, and showings, they need to sign in.`;
    }

    // Add platform-specific formatting instructions
    const platformFormattingInstructions = buildFormattingInstructions(platformContext);
    systemPrompt += '\n' + platformFormattingInstructions;

    // 🚨 FIX: Use incomingSearchId (fresh from Pub/Sub) if available, otherwise fall back to checkpointed searchId
    const currentSearchId = state.metadata?.incomingSearchId || state.metadata?.searchId;
    const hasActiveSearch = !!currentSearchId;

    console.log('[Router] ====== SearchId Resolution ======');
    console.log('[Router] incomingSearchId:', state.metadata?.incomingSearchId || 'NONE');
    console.log('[Router] checkpointed searchId:', state.metadata?.searchId || 'NONE');
    console.log('[Router] RESOLVED searchId:', currentSearchId || 'NONE');
    console.log('[Router] hasActiveSearch:', hasActiveSearch);

    // Add context about active search session if searchId exists
    const searchContext = hasActiveSearch
      ? `\n\n**🚨 CRITICAL: ACTIVE SEARCH SESSION DETECTED (Search ID: ${currentSearchId}) 🚨**\n\n` +
        `**THE USER HAS EXISTING SEARCH RESULTS LOADED IN MEMORY.**\n\n` +
        `**MANDATORY ROUTING RULES:**\n` +
        `1. If query mentions filtering price, bedrooms, size, features → MUST route to PROPERTY_OPERATIONS\n` +
        `2. If query says "keep only", "under $X", "show only", "filter to" → MUST route to PROPERTY_OPERATIONS\n` +
        `3. If query asks about sorting (cheapest, most expensive, newest) → MUST route to PROPERTY_OPERATIONS\n` +
        `4. If query asks for property details or search results → MUST route to PROPERTY_OPERATIONS\n\n` +
        `**ONLY route to PROPERTY_SEARCH if:**\n` +
        `- User explicitly asks for a COMPLETELY NEW search (different location, different property type)\n` +
        `- Example: "Find condos in Brickell" when current search is "Rentals in Coral Gables"\n\n` +
        `**EXAMPLES FOR THIS SESSION:**\n` +
        `- "keep properties under $4000" → PROPERTY_OPERATIONS (filtering existing results)\n` +
        `- "show me only 2 bedrooms" → PROPERTY_OPERATIONS (filtering existing results)\n` +
        `- "sort by price" → PROPERTY_OPERATIONS (sorting existing results)\n` +
        `- "find houses in Miami Beach" → PROPERTY_SEARCH (new search, different criteria)\n`
      : '';

    const instructions = `
Your job: Decide which specialized agent to route to, OR answer the user's question directly.

**IMPORTANT: You do NOT call tools. You just decide routing and optionally generate responses.**${searchContext}

**Routing Decision Format:**
Reply with ONLY ONE of these exact phrases at the start of your response:

1. "ROUTE: PROPERTY_SEARCH" - when user asks to FIND or SEARCH for properties (initial search or NEW search with different criteria)
2. "ROUTE: PROPERTY_FILTER" - when user wants to filter or sort EXISTING search results (legacy - being deprecated)
3. "ROUTE: PROPERTY_OPERATIONS" - when user wants to work with EXISTING search results:
   - Filter/sort properties ("under $500k", "sort by price", "keep only 3BR")
   - Get search results ("what did we find?", "show me the results")
   - Get property details ("tell me about 123 Main St", "details on first property")
4. "ROUTE: PERPLEXITY_SEARCH" - when user asks about neighborhoods, schools, amenities, market trends, best areas, etc.
5. "ROUTE: COLLECTIONS" - when user wants to manage property collections:
   - Create collection ("create a collection called Favorites")
   - List collections ("show my collections")
   - Add property to collection ("add this to my Favorites")
   - Share collection ("share my Miami collection")
6. "ROUTE: SHOWINGS" - when user wants to schedule/manage showings:
   - Schedule showing ("schedule a showing for this property")
   - List showings ("what showings do I have?")
   - Reschedule showing ("reschedule my showing to tomorrow")
   - Cancel showing ("cancel my showing")
7. "ROUTE: COMMISSIONS" - when user wants commission information:
   - Request commission ("request commission info")
   - List commission requests ("show my commission requests")
   - Check commission updates ("any commission responses?")
8. Otherwise, just answer the question directly (greetings, simple questions, capability questions)

Examples:
- "find 2 bedroom in aventura" → "ROUTE: PROPERTY_SEARCH"
- "show me only properties under $500k" → "ROUTE: PROPERTY_OPERATIONS"
- "sort by price" → "ROUTE: PROPERTY_OPERATIONS"
- "keep only under 3000" → "ROUTE: PROPERTY_OPERATIONS"
- "what were the search results?" → "ROUTE: PROPERTY_OPERATIONS"
- "tell me about 123 Ocean Drive" → "ROUTE: PROPERTY_OPERATIONS"
- "details on the first property" → "ROUTE: PROPERTY_OPERATIONS"
- "filter to 3BR and show me the cheapest" → "ROUTE: PROPERTY_OPERATIONS"
- "what are the best neighborhoods in Miami?" → "ROUTE: PERPLEXITY_SEARCH"
- "create a collection called Favorites" → "ROUTE: COLLECTIONS"
- "add this property to my collection" → "ROUTE: COLLECTIONS"
- "show my collections" → "ROUTE: COLLECTIONS"
- "share my Miami collection" → "ROUTE: COLLECTIONS"
- "schedule a showing for this property" → "ROUTE: SHOWINGS"
- "what showings do I have?" → "ROUTE: SHOWINGS"
- "cancel my showing for tomorrow" → "ROUTE: SHOWINGS"
- "request commission info" → "ROUTE: COMMISSIONS"
- "what commission requests are pending?" → "ROUTE: COMMISSIONS"
- "any commission responses?" → "ROUTE: COMMISSIONS"
- "hi" → "Hi there! How can I help you today?"
`;

    // Create user message for state updates
    const userMessage = new HumanMessage({ content: state.message });

    // Always use LLM to decide routing - no hard-coded pattern detection
    // The LLM has clear prompts with all routes, tools, and use cases
    // searchContext variable (above) passes searchId to LLM so it knows about active searches
    if (hasActiveSearch) {
      console.log(`[Router] 🔍 Active search session detected (searchId: ${currentSearchId})`);
      console.log('[Router] 💭 Letting LLM decide routing based on context...');
    }

    // Use LLM to decide routing
    // 🚨 FIX: Start fresh without conversation history to avoid tool_calls/tool messages mismatch
    // The router only needs current message + user context to make routing decisions
    // Including checkpoint history can cause OpenAI API errors if it contains orphaned tool messages
    const messages = [
      new SystemMessage({ content: `${systemPrompt}\n${instructions}` }),
      userMessage,
    ];

    console.log('[Router] Calling LLM to decide routing...');

    // Emit progress: Determining action
    await sharedPublisher.publishProgressUpdate({
      sessionId: state.metadata?.sessionId || '',
      userId: state.metadata?.userId,
      correlationId: state.metadata?.correlationId,
      status: 'Determining action...',
    });

    // Use invoke() - streamEvents() will capture chunks automatically because model has streaming: true
    const response = await model.invoke(messages);
    const responseText = response.content as string;

    console.log('[Router] 🤖 LLM Response:', responseText.substring(0, 200));

    // Check for routing directives (case-insensitive regex for robustness)
    if (/ROUTE:\s*PROPERTY[_\s]SEARCH/i.test(responseText)) {
      console.log('[Router] ✓ Routing to property_search');
      return {
        messages: [userMessage],
        userContext,
        platformContext,
        metadata: {
          ...state.metadata,
          shouldSearchProperties: true,
          shouldFilterProperties: false,
          shouldUsePropertyOperations: false,
          shouldSearchPerplexity: false,
          shouldUseCollections: false,
          shouldUseShowings: false,
          shouldUseCommissions: false,
        },
      };
    } else if (/ROUTE:\s*PROPERTY[_\s]OPERATIONS/i.test(responseText)) {
      console.log('[Router] ✓ Routing to property_operations');
      return {
        messages: [userMessage],
        userContext,
        platformContext,
        metadata: {
          ...state.metadata,
          shouldSearchProperties: false,
          shouldFilterProperties: false,
          shouldUsePropertyOperations: true,
          shouldSearchPerplexity: false,
          shouldUseCollections: false,
          shouldUseShowings: false,
          shouldUseCommissions: false,
        },
      };
    } else if (/ROUTE:\s*PROPERTY[_\s]FILTER/i.test(responseText)) {
      console.log('[Router] ✓ Routing to property_filter_sort (legacy)');
      return {
        messages: [userMessage],
        userContext,
        platformContext,
        metadata: {
          ...state.metadata,
          shouldSearchProperties: false,
          shouldFilterProperties: true,
          shouldUsePropertyOperations: false,
          shouldSearchPerplexity: false,
          shouldUseCollections: false,
          shouldUseShowings: false,
          shouldUseCommissions: false,
        },
      };
    } else if (/ROUTE:\s*PERPLEXITY[_\s]SEARCH/i.test(responseText)) {
      console.log('[Router] ✓ Routing to perplexity_search');
      return {
        messages: [userMessage],
        userContext,
        platformContext,
        metadata: {
          ...state.metadata,
          shouldSearchProperties: false,
          shouldFilterProperties: false,
          shouldUsePropertyOperations: false,
          shouldSearchPerplexity: true,
          shouldUseCollections: false,
          shouldUseShowings: false,
          shouldUseCommissions: false,
        },
      };
    } else if (/ROUTE:\s*COLLECTIONS/i.test(responseText)) {
      console.log('[Router] ✓ Routing to collections');
      return {
        messages: [userMessage],
        userContext,
        platformContext,
        metadata: {
          ...state.metadata,
          shouldSearchProperties: false,
          shouldFilterProperties: false,
          shouldUsePropertyOperations: false,
          shouldSearchPerplexity: false,
          shouldUseCollections: true,
          shouldUseShowings: false,
          shouldUseCommissions: false,
        },
      };
    } else if (/ROUTE:\s*SHOWINGS/i.test(responseText)) {
      console.log('[Router] ✓ Routing to showings');
      return {
        messages: [userMessage],
        userContext,
        platformContext,
        metadata: {
          ...state.metadata,
          shouldSearchProperties: false,
          shouldFilterProperties: false,
          shouldUsePropertyOperations: false,
          shouldSearchPerplexity: false,
          shouldUseCollections: false,
          shouldUseShowings: true,
          shouldUseCommissions: false,
        },
      };
    } else if (/ROUTE:\s*COMMISSIONS/i.test(responseText)) {
      console.log('[Router] ✓ Routing to commissions');
      return {
        messages: [userMessage],
        userContext,
        platformContext,
        metadata: {
          ...state.metadata,
          shouldSearchProperties: false,
          shouldFilterProperties: false,
          shouldUsePropertyOperations: false,
          shouldSearchPerplexity: false,
          shouldUseCollections: false,
          shouldUseShowings: false,
          shouldUseCommissions: true,
        },
      };
    } else {
      // No routing - router generated response directly
      console.log('[Router] ✓ Generated response directly (no routing needed)');

      // Adapt response for non-web platforms
      let adaptedResponse = responseText;
      if (platformContext.platform !== 'web') {
        adaptedResponse = adaptMarkdown(adaptedResponse, platformContext);
        adaptedResponse = truncateResponse(adaptedResponse, platformContext);
      }

      return {
        messages: [userMessage, response],
        userContext,
        platformContext,
        finalResponse: adaptedResponse,
        metadata: {
          ...state.metadata,
          shouldSearchProperties: false,
          shouldFilterProperties: false,
          shouldUsePropertyOperations: false,
          shouldSearchPerplexity: false,
          shouldUseCollections: false,
          shouldUseShowings: false,
          shouldUseCommissions: false,
        },
      };
    }
  } catch (error) {
    console.error('[Router] Error:', error);
    return {
      error: error instanceof Error ? error.message : 'Router node failed',
    };
  }
}
