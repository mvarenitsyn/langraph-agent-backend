import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { AgentStateType } from "../types/state.js";
import { createToolCallingModel, createResponseModel, createRouterModel } from "../models/openai.js";
import { globalToolsRegistry } from "../tools/registry.js";
import { getUserContextById } from "../utils/userContext.js";
import { sharedPublisher } from "../pubsub/shared.js";

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
5. Otherwise, just answer the question directly (greetings, simple questions, capability questions)

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
- "hi" → "Hi there! How can I help you today?"
`;

    // Create user message for state updates
    const userMessage = new HumanMessage({ content: state.message });

    // 🚨 HARD ROUTING: If searchId exists, check if this is a NEW SEARCH or FOLLOW-UP
    // This overrides LLM decision to prevent incorrect routing to property_search
    if (hasActiveSearch) {
      console.log(`[Router] 🔍 Active search session detected (searchId: ${currentSearchId})`);

      // Pattern detection for NEW SEARCH queries (even if searchId exists)
      const newSearchPatterns = /\b(find|search|show me|rentals?|condos?|homes?|properties|apartments?|houses?)\s+(in|near|around|at)\s+/i;
      const isNewSearchQuery = newSearchPatterns.test(state.message);

      if (isNewSearchQuery) {
        console.log('[Router] 🆕 Detected NEW SEARCH keywords despite existing searchId');
        console.log('[Router] 💭 Letting LLM decide routing (likely property_search)...');
        // Fall through to LLM routing below
      } else {
        console.log('[Router] ⚡ HARD ROUTING: Follow-up detected, routing to property_operations (bypassing LLM)');

        return {
          messages: [userMessage],
          userContext,
          metadata: {
            ...state.metadata,
            searchId: currentSearchId,  // 🚨 FIX: Use resolved searchId
            shouldSearchProperties: false,
            shouldFilterProperties: false,
            shouldUsePropertyOperations: true,
            shouldSearchPerplexity: false,
          },
        };
      }
    }

    // No active search - use LLM to decide routing
    // Include previous conversation history for context
    // This enables the agent to remember user's name, preferences, and previous interactions
    const messages = [
      new SystemMessage({ content: `${systemPrompt}\n${instructions}` }),
      ...(state.messages || []), // Include conversation history from checkpoint
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
        metadata: {
          ...state.metadata,
          shouldSearchProperties: true,
          shouldFilterProperties: false,
          shouldUsePropertyOperations: false,
          shouldSearchPerplexity: false,
        },
      };
    } else if (/ROUTE:\s*PROPERTY[_\s]OPERATIONS/i.test(responseText)) {
      console.log('[Router] ✓ Routing to property_operations');
      return {
        messages: [userMessage],
        userContext,
        metadata: {
          ...state.metadata,
          shouldSearchProperties: false,
          shouldFilterProperties: false,
          shouldUsePropertyOperations: true,
          shouldSearchPerplexity: false,
        },
      };
    } else if (/ROUTE:\s*PROPERTY[_\s]FILTER/i.test(responseText)) {
      console.log('[Router] ✓ Routing to property_filter_sort (legacy)');
      return {
        messages: [userMessage],
        userContext,
        metadata: {
          ...state.metadata,
          shouldSearchProperties: false,
          shouldFilterProperties: true,
          shouldUsePropertyOperations: false,
          shouldSearchPerplexity: false,
        },
      };
    } else if (/ROUTE:\s*PERPLEXITY[_\s]SEARCH/i.test(responseText)) {
      console.log('[Router] ✓ Routing to perplexity_search');
      return {
        messages: [userMessage],
        userContext,
        metadata: {
          ...state.metadata,
          shouldSearchProperties: false,
          shouldFilterProperties: false,
          shouldUsePropertyOperations: false,
          shouldSearchPerplexity: true,
        },
      };
    } else {
      // No routing - router generated response directly
      console.log('[Router] ✓ Generated response directly (no routing needed)');

      return {
        messages: [userMessage, response],
        userContext,
        finalResponse: responseText,
        metadata: {
          ...state.metadata,
          shouldSearchProperties: false,
          shouldFilterProperties: false,
          shouldUsePropertyOperations: false,
          shouldSearchPerplexity: false,
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
