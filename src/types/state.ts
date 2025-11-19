import { Annotation } from "@langchain/langgraph";
import { BaseMessage } from "@langchain/core/messages";

/**
 * User Context for personalization
 * Received from frontend/backend with authentication and profile info
 */
export interface UserContext {
  isAuthenticated?: boolean;
  fullName?: string;
  email?: string;
  preferences?: Record<string, any>;
  searchHistory?: string[];
  savedProperties?: string[];
}

/**
 * SIMPLIFIED Agent State Definition
 *
 * This defines the state structure for the LangGraph agent.
 * The state persists across all nodes in the graph and through checkpoints.
 *
 * Removed during simplification (January 2025):
 * - reflection: reflect node removed
 * - retryCount/maxRetries: retry logic removed
 * - pendingToolCalls/statusMessages: parallel execution removed
 */
export const AgentState = Annotation.Root({
  /**
   * Messages array - contains the conversation history
   * Includes user messages, AI responses, and tool results
   * Reducer concatenates new messages with existing ones
   */
  messages: Annotation<BaseMessage[]>({
    reducer: (existing, incoming) => existing.concat(incoming),
    default: () => [],
  }),

  /**
   * Current message/query being processed
   */
  message: Annotation<string>({
    reducer: (_, incoming) => incoming,
    default: () => "",
  }),

  /**
   * Intermediate results from tools
   * Used for passing tool results to generate_response node
   */
  toolResults: Annotation<Record<string, any>>({
    reducer: (existing, incoming) => ({ ...existing, ...incoming }),
    default: () => ({}),
  }),

  /**
   * Final response to be returned to the user
   * Generated ONLY by generate_response node
   */
  finalResponse: Annotation<string | null>({
    reducer: (_, incoming) => incoming,
    default: () => null,
  }),

  /**
   * Error tracking
   */
  error: Annotation<string | null>({
    reducer: (_, incoming) => incoming,
    default: () => null,
  }),

  /**
   * Session metadata
   * Used for sessionId, userId, etc. from frontend/backend
   */
  metadata: Annotation<Record<string, any>>({
    reducer: (existing, incoming) => ({ ...existing, ...incoming }),
    default: () => ({}),
  }),

  /**
   * User context for personalization
   * Contains authentication status and user profile information
   */
  userContext: Annotation<UserContext>({
    reducer: (existing, incoming) => ({ ...existing, ...incoming }),
    default: () => ({ isAuthenticated: false }),
  }),
});

export type AgentStateType = typeof AgentState.State;
