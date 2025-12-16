import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { AgentStateType, TaskList, TaskItem, RouteType } from "../types/state.js";
import { createToolCallingModel, createResponseModel, createRouterModel } from "../models/openai.js";
import { globalToolsRegistry } from "../tools/registry.js";
import { getUserContextById } from "../utils/userContext.js";
import { sharedPublisher } from "../pubsub/shared.js";
import { getPlatformContext } from "../utils/platformContext.js";
import { buildFormattingInstructions, adaptMarkdown, truncateResponse } from "../utils/formatters.js";
import { v4 as uuidv4 } from "uuid";

/**
 * Router Node - LLM-Based Task List Generation
 *
 * This node uses LLM to:
 * 1. Decide if query is conversational (direct response)
 * 2. Otherwise, generate a task list with one or more tasks
 * 3. Be context-aware about active search sessions (searchId)
 *
 * Flow:
 * - Conversational queries → direct response → END
 * - Task-based queries → task list → task_executor → route nodes → task_complete → loop or synthesize
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

    // Check for image attachment
    const hasImageAttachment = !!state.imageAttachment;
    console.log(`[Router] 🖼️ Image attachment detected: ${hasImageAttachment}`);
    if (hasImageAttachment) {
      console.log(`[Router] Image: ${state.imageAttachment!.mimeType}, ${(state.imageAttachment!.sizeBytes / 1024).toFixed(1)}KB`);
    }
    const imageContext = hasImageAttachment
      ? `\n\n**📷 IMAGE ATTACHMENT DETECTED** (${state.imageAttachment!.mimeType}, ${(state.imageAttachment!.sizeBytes / 1024).toFixed(1)}KB)\n` +
        `If the user is asking for similar properties/rooms/styles, you MUST:\n` +
        `1. First create a PROPERTY_SEARCH task with location/price criteria\n` +
        `2. Then create an IMAGE_SIMILARITY_SEARCH task to rank by visual similarity\n`
      : '';

    const instructions = `
Your job: Analyze the user's query and decide:${imageContext}

## Decision 1: Is this conversational?
Conversational queries (respond directly, no tasks):
- Greetings: "hello", "hi", "hey", "good morning"
- Thanks: "thank you", "thanks", "appreciated"
- Acknowledgments: "ok", "got it", "sure", "great"
- Clarification questions about the system
- General chitchat not related to real estate tasks
- Capability questions: "what can you do?", "how do you work?"

If conversational → Generate your response directly (no JSON).

## Decision 2: All other queries → Generate Task List
For ANY query that requires action, generate a JSON task list.

**IMPORTANT: Return ONLY this JSON format (no markdown, no explanation):**

\`\`\`json
{
  "tasks": [
    { "route": "ROUTE_NAME", "task": "Natural language instruction for this step" }
  ]
}
\`\`\`

## Route Options:
- **PROPERTY_SEARCH**: Search for properties (new search criteria)
- **PROPERTY_OPERATIONS**: Work with search results (filter, sort, details, CMA, get results)
- **IMAGE_SIMILARITY_SEARCH**: Find properties with visually similar rooms (requires image attachment)
- **PERPLEXITY_SEARCH**: Web research (neighborhoods, market trends, schools)
- **COLLECTIONS**: Manage property collections
- **SHOWINGS**: Schedule/manage showings
- **COMMISSIONS**: Commission requests

${searchContext}

## IMAGE SIMILARITY SEARCH:
If the user has attached an image AND uses words like "similar", "like this", "matching", "find properties like":
1. FIRST run PROPERTY_SEARCH to filter by location/price criteria
2. THEN run IMAGE_SIMILARITY_SEARCH to rank by visual similarity within those results

Example: User attaches kitchen photo + "Find similar kitchens in Aventura under $1M"
→ 2 tasks: PROPERTY_SEARCH (Aventura under $1M), then IMAGE_SIMILARITY_SEARCH (rank by kitchen similarity)

## Context-Aware Task Generation Examples:

**NO ACTIVE SEARCH (user hasn't searched yet):**
- "find 3BR in Miami" → 1 task: PROPERTY_SEARCH
- "get agent details for property 123" → 2 tasks: PROPERTY_SEARCH (find property), then PROPERTY_OPERATIONS (get details)
- "get listing agent for 3101 Bayshore Drive" → 2 tasks: PROPERTY_SEARCH (find by address), then PROPERTY_OPERATIONS (get agent info)
- "who is the agent for 123 Ocean Drive" → 2 tasks: PROPERTY_SEARCH (find by address), then PROPERTY_OPERATIONS (get details)
- "details for property at 500 Brickell Ave" → 2 tasks: PROPERTY_SEARCH (find by address), then PROPERTY_OPERATIONS (get full details)
- "get me info about the house on Palm Island" → 2 tasks: PROPERTY_SEARCH (find by address), then PROPERTY_OPERATIONS (get details)
- "schedule showing for a condo in Brickell" → 3 tasks: PROPERTY_SEARCH, PROPERTY_OPERATIONS (identify), SHOWINGS

**WITH ACTIVE SEARCH (user has search results):**
- "show me details of the first one" → 1 task: PROPERTY_OPERATIONS
- "filter to under $500k" → 1 task: PROPERTY_OPERATIONS
- "schedule a showing for the cheapest" → 2 tasks: PROPERTY_OPERATIONS (identify), SHOWINGS
- "find houses in Miami Beach" (NEW search) → 1 task: PROPERTY_SEARCH

**Example JSON outputs:**

Single task (with active search):
\`\`\`json
{"tasks":[{"route":"PROPERTY_OPERATIONS","task":"Get detailed agent/listing information for the first property in results"}]}
\`\`\`

Multiple tasks (no active search):
\`\`\`json
{"tasks":[{"route":"PROPERTY_SEARCH","task":"Search for 3-bedroom condos in Aventura under $600k"},{"route":"PROPERTY_OPERATIONS","task":"Get detailed listing agent information for the top result"}]}
\`\`\`

Multi-step workflow:
\`\`\`json
{"tasks":[{"route":"PROPERTY_SEARCH","task":"Search for rental properties in Coral Gables"},{"route":"PROPERTY_OPERATIONS","task":"Identify the cheapest available property"},{"route":"SHOWINGS","task":"Schedule a showing for the identified property"}]}
\`\`\`

**CRITICAL RULES:**
1. Return ONLY JSON for task-based queries (no markdown, no explanation)
2. Return plain text for conversational queries (no JSON)
3. Be context-aware: if searchId exists, don't create unnecessary PROPERTY_SEARCH tasks
4. Each task instruction should be specific and actionable
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

    console.log('[Router] 🤖 LLM Response:', responseText.substring(0, 300));

    // Try to parse as JSON task list
    const taskListResult = parseTaskListResponse(responseText);

    if (taskListResult) {
      // Task-based query - create task list and route to task_executor
      console.log(`[Router] ✓ Generated task list with ${taskListResult.tasks.length} task(s)`);
      taskListResult.tasks.forEach((t, i) => {
        console.log(`[Router]   Task ${i + 1}: ${t.route} - "${t.task}"`);
      });

      // Build TaskList structure
      const taskList: TaskList = {
        tasks: taskListResult.tasks.map(t => ({
          id: uuidv4(),
          route: t.route as RouteType,
          task: t.task,
          status: 'pending' as const,
        })),
        currentTaskIndex: 0,
        originalQuery: state.message,
      };

      return {
        messages: [userMessage],
        userContext,
        platformContext,
        taskList,
        metadata: {
          ...state.metadata,
          // Set flag to route to task_executor
          shouldUseTaskExecutor: true,
          // Clear all direct routing flags
          shouldSearchProperties: false,
          shouldFilterProperties: false,
          shouldUsePropertyOperations: false,
          shouldSearchPerplexity: false,
          shouldUseCollections: false,
          shouldUseShowings: false,
          shouldUseCommissions: false,
        },
      };
    } else {
      // Conversational query - router generated response directly
      console.log('[Router] ✓ Generated conversational response (no tasks)');

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
        taskList: null, // Explicitly no task list
        metadata: {
          ...state.metadata,
          shouldUseTaskExecutor: false,
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

/**
 * Parse LLM response to extract task list JSON
 * Returns null if response is not a valid task list (conversational response)
 */
function parseTaskListResponse(responseText: string): { tasks: Array<{ route: string; task: string }> } | null {
  // Try to extract JSON from the response
  // The LLM might wrap it in markdown code blocks or return it directly

  // First, try to find JSON in code blocks
  const codeBlockMatch = responseText.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1]);
      if (isValidTaskList(parsed)) {
        return parsed;
      }
    } catch (e) {
      // Not valid JSON in code block
    }
  }

  // Try to find raw JSON object
  const jsonMatch = responseText.match(/\{[\s\S]*"tasks"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (isValidTaskList(parsed)) {
        return parsed;
      }
    } catch (e) {
      // Not valid JSON
    }
  }

  // Not a task list response - must be conversational
  return null;
}

/**
 * Validate that parsed JSON is a valid task list
 */
function isValidTaskList(obj: any): obj is { tasks: Array<{ route: string; task: string }> } {
  if (!obj || typeof obj !== 'object') return false;
  if (!Array.isArray(obj.tasks)) return false;
  if (obj.tasks.length === 0) return false;

  // Valid route types
  const validRoutes = [
    'PROPERTY_SEARCH',
    'PROPERTY_OPERATIONS',
    'PROPERTY_FILTER',
    'IMAGE_SIMILARITY_SEARCH',
    'PERPLEXITY_SEARCH',
    'COLLECTIONS',
    'SHOWINGS',
    'COMMISSIONS',
    'DIRECT_RESPONSE',
  ];

  return obj.tasks.every((task: any) =>
    task &&
    typeof task === 'object' &&
    typeof task.route === 'string' &&
    validRoutes.includes(task.route) &&
    typeof task.task === 'string' &&
    task.task.length > 0
  );
}
