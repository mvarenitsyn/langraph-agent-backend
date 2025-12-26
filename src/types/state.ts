import { Annotation } from "@langchain/langgraph";
import { BaseMessage } from "@langchain/core/messages";
import { PlatformContext, DEFAULT_PLATFORM_CONTEXT } from "./platform.js";

/**
 * Route types for task orchestration
 */
export type RouteType =
  | 'PROPERTY_SEARCH'
  | 'PROPERTY_OPERATIONS'
  | 'PROPERTY_FILTER'
  | 'PERPLEXITY_SEARCH'
  | 'IMAGE_SIMILARITY_SEARCH'
  | 'COLLECTIONS'
  | 'SHOWINGS'
  | 'COMMISSIONS'
  | 'DIRECT_RESPONSE';

/**
 * Image attachment for similarity search
 */
export interface ImageAttachment {
  base64Data: string;  // No 'data:image/...' prefix
  mimeType: string;
  filename?: string;
  sizeBytes: number;
}

/**
 * Task Item - represents a single step in a multi-step workflow
 */
export interface TaskItem {
  id: string;                          // Unique task ID (uuid)
  route: RouteType;                    // Route to execute
  task: string;                        // Natural language instruction for the route
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';
  dependsOn?: string[];                // Task IDs this depends on (for future parallel execution)
  result?: {
    searchId?: string;
    toolResults?: Record<string, any>;
    response?: string;
    totalCount?: number;
  };
  error?: string;                      // Error message if failed
  skipReason?: string;                 // Reason for skipping (if status is 'skipped')
}

/**
 * Task List - orchestrates multi-step workflows
 */
export interface TaskList {
  tasks: TaskItem[];
  currentTaskIndex: number;
  originalQuery: string;               // User's original message
}

/**
 * User Context for personalization
 * Comprehensive user profile with all related data
 */
export interface UserContext {
  // Authentication status
  isAuthenticated: boolean;

  // Basic user profile (from users table)
  userId?: string;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  licenseNumber?: string;
  licenseState?: string;
  memberKey?: string;
  memberMlsId?: string;
  officeKey?: string;
  officeName?: string;
  profilePicture?: string;
  bio?: string;
  website?: string;
  status?: string;

  // Related data counts
  linkedListingsCount?: number;
  collectionsCount?: number;
  cmasCount?: number;
  showingsCount?: number;

  // Related data (detailed)
  listings?: Array<{
    listingId: string;
    linkedAt: string;
    linkedVia: string;
    isActive: boolean;
    listingData?: any;
  }>;

  collections?: Array<{
    id: string;
    title: string;
    description?: string;
    propertiesCount: number;
    createdAt: string;
    updatedAt: string;
  }>;

  cmas?: Array<{
    id: string;
    jobId: string;
    listingId: string;
    status: string;
    progressPercentage: number;
    propertyAddress: string;
    createdAt: string;
    completedAt?: string;
  }>;

  showings?: Array<{
    id: string;
    propertyId?: string;
    propertyAddress?: string;
    scheduledAt?: string;
    status: string;
    requesterName?: string;
    createdAt: string;
  }>;

  // Legacy fields (kept for backward compatibility)
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

  /**
   * Platform context for platform-aware behavior
   * Contains capabilities, formatting rules, and tool configuration
   * Used to adapt responses for different platforms (web, whatsapp)
   */
  platformContext: Annotation<PlatformContext>({
    reducer: (existing, incoming) => ({ ...existing, ...incoming }),
    default: () => DEFAULT_PLATFORM_CONTEXT,
  }),

  /**
   * Task list for multi-step workflow orchestration
   * Contains tasks to be executed sequentially
   * Generated by router, consumed by taskExecutor
   */
  taskList: Annotation<TaskList | null>({
    reducer: (_, incoming) => incoming,
    default: () => null,
  }),

  /**
   * Image attachment for similarity search
   * Base64 encoded image sent from frontend for visual similarity matching
   */
  imageAttachment: Annotation<ImageAttachment | null>({
    reducer: (_, incoming) => incoming,
    default: () => null,
  }),
});

export type AgentStateType = typeof AgentState.State;
