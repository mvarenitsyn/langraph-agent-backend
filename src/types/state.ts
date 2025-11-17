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
 * Agent State Definition
 *
 * This defines the state structure for the LangGraph agent.
 * The state persists across all nodes in the graph and through checkpoints.
 */
export const AgentState = Annotation.Root({
  /**
   * Messages array - contains the conversation history
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
   */
  toolResults: Annotation<Record<string, any>>({
    reducer: (existing, incoming) => ({ ...existing, ...incoming }),
    default: () => ({}),
  }),

  /**
   * Reflection output from the reflect node
   */
  reflection: Annotation<string | null>({
    reducer: (_, incoming) => incoming,
    default: () => null,
  }),

  /**
   * Retry count for error handling
   */
  retryCount: Annotation<number>({
    reducer: (existing, incoming) => incoming ?? existing,
    default: () => 0,
  }),

  /**
   * Maximum retries allowed
   */
  maxRetries: Annotation<number>({
    reducer: (_, incoming) => incoming,
    default: () => 3,
  }),

  /**
   * Final response to be returned to the user
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

  /**
   * Pending tool calls extracted from last AIMessage
   * Used by generate-status node to create status messages in parallel
   */
  pendingToolCalls: Annotation<Array<{ id: string; name: string; args: Record<string, any> }>>({
    reducer: (_, incoming) => incoming,
    default: () => [],
  }),

  /**
   * Status messages generated for each tool call
   * Maps toolCallId -> status message for tracking
   */
  statusMessages: Annotation<Record<string, string>>({
    reducer: (existing, incoming) => ({ ...existing, ...incoming }),
    default: () => ({}),
  }),
});

export type AgentStateType = typeof AgentState.State;
